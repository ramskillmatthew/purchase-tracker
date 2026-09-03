import Papa from "papaparse";

/**
 * Parses eBay's own downloaded Feed API result file back into a per-row
 * outcome, correlated by SKU.
 *
 * DISCLOSED LIMITATION — the exact column names and status vocabulary
 * eBay's FX_LISTING result file actually uses were NOT confirmed against
 * an authoritative, worked example this session (no real result file has
 * ever been downloaded — see this application's own not-authorized list:
 * no real Feed task has been created yet). This parser is deliberately
 * FAIL-CLOSED rather than a confident, guessed mapping: it looks for the
 * SKU column by the exact upload header name first (falling back to any
 * column whose name contains "sku"), and a status column among the most
 * commonly documented Feed API result conventions across eBay's OTHER feed
 * types (Status / Action Status / Result / Errors) — but every row whose
 * status text isn't recognised as an unambiguous success is treated as a
 * FAILURE, never optimistically treated as success. The raw status text is
 * always preserved in the returned message so a real discrepancy is
 * immediately visible and correctable once this pipeline's very first real
 * result file is actually observed (necessarily outside this session).
 *
 * This function throws (rather than returning a best-guess empty result)
 * only when the file cannot be parsed as CSV at all, or has no recognisable
 * SKU column — both mean this application cannot safely correlate ANY row,
 * so silently reporting "0 rows, all failed" would be misleading; the
 * caller must treat a thrown error here as a genuine batch-level failure.
 */

export type FeedResultRow = { sku: string; ok: boolean; message: string | null; rawStatus: string | null };
export type ParsedFeedResult = { rows: FeedResultRow[]; recognisedStatusColumn: boolean };

const SKU_COLUMN_CANDIDATES = ["custom label (sku)", "custom label", "sku"];
const STATUS_COLUMN_CANDIDATES = ["status", "action status", "actionstatus", "result", "errors"];
const MESSAGE_COLUMN_CANDIDATES = ["error", "errors", "message", "description", "reason", "longmessage", "long message"];

const SUCCESS_WORDS = ["success", "succeeded", "created", "processed", "complete", "completed", "ok"];
const FAILURE_WORDS = ["error", "fail", "failed", "invalid", "reject", "rejected"];

function findColumn(headers: string[], candidates: string[]): string | null {
  const lowerHeaders = headers.map(h => h.toLowerCase().trim());
  for (const candidate of candidates) {
    const index = lowerHeaders.indexOf(candidate);
    if (index !== -1) return headers[index];
  }
  // Loose fallback — a header that merely CONTAINS the candidate word.
  for (const candidate of candidates) {
    const index = lowerHeaders.findIndex(h => h.includes(candidate));
    if (index !== -1) return headers[index];
  }
  return null;
}

export function parseFeedResultCsv(csv: string): ParsedFeedResult {
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0 && (!parsed.data || parsed.data.length === 0)) {
    throw new Error("eBay's result file could not be parsed as CSV.");
  }
  const headers = parsed.meta.fields ?? [];
  const skuColumn = findColumn(headers, SKU_COLUMN_CANDIDATES);
  if (!skuColumn) {
    throw new Error(`eBay's result file did not contain a recognisable SKU column (columns seen: ${headers.join(", ") || "none"}).`);
  }
  const statusColumn = findColumn(headers, STATUS_COLUMN_CANDIDATES);
  const messageColumn = findColumn(headers, MESSAGE_COLUMN_CANDIDATES);

  const rows: FeedResultRow[] = [];
  for (const record of parsed.data) {
    const sku = record[skuColumn]?.trim();
    if (!sku) continue;
    const rawStatus = statusColumn ? (record[statusColumn]?.trim() || null) : null;
    const rawMessage = messageColumn ? (record[messageColumn]?.trim() || null) : null;
    const statusLower = (rawStatus ?? "").toLowerCase();
    const isFailureWord = FAILURE_WORDS.some(word => statusLower.includes(word));
    const isSuccessWord = SUCCESS_WORDS.some(word => statusLower.includes(word));
    // Fail-closed: only an UNAMBIGUOUS success word, with no failure word
    // also present, counts as ok. No recognised status text at all is
    // treated as a failure, never assumed successful.
    const ok = isSuccessWord && !isFailureWord;
    rows.push({
      sku,
      ok,
      message: ok ? null : (rawMessage ?? (rawStatus ? `eBay reported: "${rawStatus}"` : "eBay did not report a recognisable result for this row.")),
      rawStatus,
    });
  }

  return { rows, recognisedStatusColumn: statusColumn !== null };
}
