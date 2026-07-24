import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { taskCompletionSchema, taskInputSchema } from "@/lib/validation/task";

export async function GET() {
  try {
    const user = await requireOwner();
    const response = await supabaseRequest(`tasks?owner_id=eq.${user.id}&select=*&order=completed.asc,due_date.asc.nullslast,created_at.desc`);
    return NextResponse.json(await response.json());
  } catch (e) { return safeApiError(e); }
}

export async function POST(request: Request) {
  try {
    const user = await requireOwner();
    const body = taskInputSchema.parse(await request.json());
    await supabaseRequest("tasks", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...body, owner_id: user.id }) });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) { return safeApiError(e, "Could not save task."); }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireOwner();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Task ID is required." }, { status: 400 });

    const raw = await request.json();
    const now = new Date().toISOString();
    // Two distinct operations share this endpoint: a normal field edit, and
    // the completion transition. Detected by the presence of `completed` in
    // the body — completed_at is never accepted from the client either way,
    // it's always derived here.
    const isCompletionTransition = typeof raw === "object" && raw !== null && "completed" in raw;
    const patch = isCompletionTransition
      ? (() => {
          const { completed } = taskCompletionSchema.parse(raw);
          return completed ? { completed: true, completed_at: now, updated_at: now } : { completed: false, completed_at: null, updated_at: now };
        })()
      : { ...taskInputSchema.parse(raw), updated_at: now };

    // Service-role bypasses RLS, so ownership must be enforced explicitly
    // here — every lookup and mutation is scoped by id AND owner_id,
    // never id alone.
    const existing = await (await supabaseRequest(`tasks?id=eq.${encodeURIComponent(id)}&owner_id=eq.${user.id}&select=id`)).json() as { id: string }[];
    if (!existing.length) return NextResponse.json({ error: "Task not found." }, { status: 404 });

    await supabaseRequest(`tasks?id=eq.${encodeURIComponent(id)}&owner_id=eq.${user.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
    return NextResponse.json({ ok: true });
  } catch (e) { return safeApiError(e, "Could not update task."); }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireOwner();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Task ID is required." }, { status: 400 });
    const existing = await (await supabaseRequest(`tasks?id=eq.${encodeURIComponent(id)}&owner_id=eq.${user.id}&select=id`)).json() as { id: string }[];
    if (!existing.length) return NextResponse.json({ error: "Task not found." }, { status: 404 });
    await supabaseRequest(`tasks?id=eq.${encodeURIComponent(id)}&owner_id=eq.${user.id}`, { method: "DELETE" });
    return NextResponse.json({ ok: true });
  } catch (e) { return safeApiError(e, "Could not delete task."); }
}
