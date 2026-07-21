import { NextResponse } from "next/server";
import { AuthError } from "./server";
import { ZodError } from "zod";

export function safeApiError(error: unknown, fallback = "Request failed.") {
  if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ error: "Invalid request.", issues: error.issues.map(x => ({ path: x.path.join("."), message: x.message })) }, { status: 400 });
  if (error instanceof Error && "status" in error && error.status === 400 && /column .* does not exist|schema cache/i.test(error.message)) return NextResponse.json({ error: "The purchase-import database update has not been installed. Run the four purchase-import ALTER TABLE statements in the Supabase SQL Editor, then try again." }, { status: 500 });
  if (error instanceof Error && "status" in error && error.status === 429) return NextResponse.json({ error: error.message }, { status: 429 });
  if (error instanceof Error && "status" in error && error.status === 401) return NextResponse.json({ error: "The Supabase server secret was rejected. Replace SUPABASE_SECRET_KEY in .env.local with the secret key from the same Supabase project as NEXT_PUBLIC_SUPABASE_URL, then restart the app." }, { status: 500 });
  console.error(fallback, error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ error: fallback }, { status: 500 });
}
