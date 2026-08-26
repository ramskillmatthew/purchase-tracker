import { z } from "zod";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { runRefresh } from "@/lib/investments/refresh";

export const runtime = "nodejs";
export const maxDuration = 60;

// Server-validated — a client can only ever submit one of these two real
// UI-originated triggers ('cron' is never reachable from this route at all;
// it's only ever passed by app/api/cron/investments-refresh/route.ts
// calling runRefresh() directly, never through this HTTP endpoint).
// Confirmed-live gap this fixes: this route used to hard-code "manual"
// regardless of caller, so InvestmentsWorkspace's own auto-on-page-open
// refresh was indistinguishable from a real button click in
// investment_refresh_runs.trigger — impossible to tell what actually
// started a given run.
const requestBodySchema = z.object({ trigger: z.enum(["manual", "auto_page_open"]).default("manual") }).strict();

/**
 * Streams newline-delimited JSON so the client can show real, meaningful
 * refresh progress ("Refreshing prices · 7 of 18") instead of an opaque
 * spinner while Twelve Data pacing alone can take a minute or more — each
 * `{"type":"progress",...}` line is only ever written AFTER a holding's
 * result (including any retry) is fully final, so the UI can never show a
 * holding as done a moment before its own retry actually finishes. The
 * last line is always `{"type":"done","result":...}`, carrying the exact
 * same RefreshRunResult (or {skipped}) shape this route returned before
 * streaming existed — existing consumers of the final result are
 * unaffected, only HOW it arrives changed.
 */
export async function POST(request: Request) {
  let user: Awaited<ReturnType<typeof requireOwner>>;
  try {
    user = await requireOwner();
  } catch (error) { return safeApiError(error, "Could not refresh prices."); }

  let trigger: "manual" | "auto_page_open" = "manual";
  const rawBody = await request.text();
  if (rawBody) {
    try { trigger = requestBodySchema.parse(JSON.parse(rawBody)).trigger; }
    catch (error) { return safeApiError(error, "Could not refresh prices."); }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // A dead client connection makes controller.enqueue() throw once the
      // underlying stream is closed — confirmed live as the exact root
      // cause of an orphaned 'running' refresh run (see refresh.ts's own
      // comment on this): that throw used to propagate straight out of
      // runRefresh's onProgress callback, aborting the whole refresh mid-
      // loop before its own DB finalization ever ran. Progress reporting
      // is best-effort telemetry — losing the ability to report it must
      // never abort real, already-in-flight provider work and DB writes.
      function write(line: object) {
        try { controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)); }
        catch { /* client is gone — the refresh itself keeps running server-side to completion; see runRefresh's own try/finally for the belt-and-braces run finalization */ }
      }
      try {
        const result = await runRefresh(user.id, trigger, progress => write({ type: "progress", ...progress }));
        write({ type: "done", result });
      } catch (error) {
        write({ type: "done", error: error instanceof Error ? error.message : "Could not refresh prices." });
      } finally {
        try { controller.close(); } catch { /* already closed/errored (e.g. client disconnected) — nothing left to do */ }
      }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
