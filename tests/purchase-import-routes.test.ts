import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// These route handlers are Next.js server routes (some import "server-only"
// transitively via lib/anthropic/ai-extract.ts) and touch Supabase directly,
// so — consistent with the existing security-boundaries.test.ts pattern —
// their behaviour is asserted structurally against the source text rather
// than by importing and invoking them.
const syncSource = readFileSync("app/api/vinted/sync/route.ts", "utf8");
const candidatesSource = readFileSync("app/api/vinted/candidates/route.ts", "utf8");
const importSource = readFileSync("app/api/vinted/import/route.ts", "utf8");
const exportSource = readFileSync("app/api/export/purchases/route.ts", "utf8");

describe("sync route: candidate preservation (REGRESSION — the destructive delete-before-scan is gone)", () => {
  it("REGRESSION: no longer deletes unimported candidates before scanning", () => {
    expect(syncSource).not.toMatch(/DELETE[\s\S]*import_status=neq\.imported/);
    expect(syncSource).not.toContain('{ method: "DELETE" }');
  });

  it("REGRESSION: upserts on the stable per-item source_item_key, not the old message-only key", () => {
    expect(syncSource).toContain("vinted_import_candidates?on_conflict=source_item_key");
    expect(syncSource).not.toContain('vinted_import_candidates?on_conflict=yahoo_message_id"');
  });

  it("computes source_item_key via the shared, testable identity helper rather than an inline formula", () => {
    expect(syncSource).toContain("import { sourceItemKey } from \"@/lib/purchase-import/identity\"");
    expect(syncSource).toContain("sourceItemKey(order.messageId, row.itemIndex, row.unitIndex)");
  });

  it("still upserts (merge-duplicates) rather than always inserting fresh rows, so a re-scanned email updates in place", () => {
    expect(syncSource).toContain("resolution=merge-duplicates");
  });

  it("REGRESSION: order_reference is stored exactly as extracted, with no artificial per-item suffix — source_item_key carries the per-item identity instead", () => {
    expect(syncSource).toContain("order_reference: order.orderReference,");
    expect(syncSource).not.toMatch(/order_reference:\s*`\$\{order\.orderReference\}/);
  });

  it("REGRESSION: resolves each fetched email's provider via its own signed id, never via order.messageId (a different identifier per provider, causing every Gmail candidate to silently default to yahoo)", () => {
    expect(syncSource).toContain("import { resolveSourceProvider, resolveSourceAccount } from \"@/lib/purchase-import/provider\"");
    expect(syncSource).toContain("resolveSourceProvider(email.id, providerById)");
    expect(syncSource).not.toContain("providerById.get(order.messageId)");
    expect(syncSource).not.toMatch(/const provider[^;]*\|\|\s*"yahoo"/);
  });

  it("REGRESSION: never processes an email whose provider couldn't be resolved — no silent 'yahoo' fallback", () => {
    const loopBody = syncSource.slice(syncSource.indexOf("for (const email of emails)"), syncSource.indexOf("if (!order) continue;"));
    expect(loopBody).toContain("if (!provider) continue;");
  });

  it("attributes source_account via the same resolved provider, never a hardcoded/mismatched account", () => {
    expect(syncSource).toContain("resolveSourceAccount(provider, { gmailAccountEmail, yahooEmail: process.env.YAHOO_EMAIL || null })");
  });
});

describe("sync route: multi-item expansion and AI fallback are wired in", () => {
  it("expands each parsed order through expandOrderToRows before building candidate records", () => {
    expect(syncSource).toContain("expandOrderToRows(");
  });

  it("stamps item_index/unit_index/order_total_paid/source_provider/source_account/item_condition_hint/source_item_key on every record", () => {
    for (const column of ["item_index:", "unit_index:", "order_total_paid:", "source_provider:", "source_account:", "item_condition_hint:", "source_item_key:"]) {
      expect(syncSource).toContain(column);
    }
  });

  it("REGRESSION: never writes to the draft column — a re-sync can never overwrite a reviewer's saved edits", () => {
    expect(syncSource).not.toMatch(/\bdraft\s*:/);
  });

  it("flags a content-fingerprint collision across different source emails for manual review, rather than silently treating them as separate orders", () => {
    expect(syncSource).toContain("messageIdsByFingerprint");
    expect(syncSource).toMatch(/possible duplicate order/i);
  });

  it("gives each candidate record its own independent uncertainty_reasons array, so flagging one row can never silently duplicate the warning onto unrelated records", () => {
    expect(syncSource).toContain("uncertainty_reasons: [...rowUncertainty]");
  });

  it("only calls the AI fallback when the deterministic parse is missing or genuinely ambiguous, and bounds it per sync run", () => {
    expect(syncSource).toContain("needsAiFallback(order)");
    expect(syncSource).toMatch(/aiAssisted\s*<\s*AI_EXTRACTION_LIMIT/);
    expect(syncSource).toContain("extractOrderWithAi(");
  });

  it("never lets the AI fallback override an already-complete deterministic parse", () => {
    const fallbackBlock = syncSource.slice(syncSource.indexOf("if (needsAiFallback"), syncSource.indexOf("if (!order) continue;"));
    expect(fallbackBlock).toContain("if (aiOrder) order = aiOrder;");
  });
});

describe("candidates route: soft reject/restore alongside the existing hard delete", () => {
  it("GET defaults to the pending status and supports rejected/all", () => {
    expect(candidatesSource).toContain('|| "pending"');
    expect(candidatesSource).toContain('"rejected"');
    expect(candidatesSource).toContain('"all"');
  });

  it("REGRESSION: adds a PATCH handler that sets import_status to 'rejected'/'pending' instead of deleting", () => {
    expect(candidatesSource).toContain("export async function PATCH");
    expect(candidatesSource).toContain('"rejected"');
    expect(candidatesSource).toMatch(/action === "reject" \? "rejected" : "pending"/);
  });

  it("keeps the existing hard-delete endpoint available (nothing existing was removed)", () => {
    expect(candidatesSource).toContain("export async function DELETE");
    expect(candidatesSource).toContain("clear") ;
  });

  it("keeps the exact existing duplicate-prevention filter strings intact (structural regression guard)", () => {
    expect(candidatesSource).toContain("import_status=neq.imported");
    expect(candidatesSource).toContain("import_status=neq.imported&select=id");
  });
});

describe("candidates route: persisted draft edits (REGRESSION — review edits used to live only in React state)", () => {
  it("validates the full set of exported/reviewable fields on the draft payload", () => {
    for (const field of ["purchased_from", "sku", "item_description", "seller_name", "item_size", "item_condition", "price_purchased", "order_date", "arrived"]) {
      expect(candidatesSource).toContain(field);
    }
  });

  it("handles save_draft as a distinct PATCH action from reject/restore", () => {
    expect(candidatesSource).toContain('action: z.literal("save_draft")');
    expect(candidatesSource).toContain('parsed.action === "save_draft"');
  });

  it("still enforces the owner-scoped, not-yet-imported existence check before saving a draft", () => {
    const saveDraftBlock = candidatesSource.slice(candidatesSource.indexOf("export async function PATCH"), candidatesSource.indexOf("export async function DELETE"));
    const existingCheckIndex = saveDraftBlock.indexOf("import_status=neq.imported");
    const saveDraftIndex = saveDraftBlock.indexOf('"save_draft"', saveDraftBlock.indexOf("if (parsed.action"));
    expect(existingCheckIndex).toBeGreaterThanOrEqual(0);
    expect(existingCheckIndex).toBeLessThan(saveDraftIndex);
  });

  it("REGRESSION: saving a draft writes only the draft column, never import_status, and is not audited like reject/restore", () => {
    const saveDraftBlock = candidatesSource.slice(candidatesSource.indexOf('if (parsed.action === "save_draft")'), candidatesSource.indexOf("const nextStatus"));
    expect(saveDraftBlock).toContain("draft: parsed.draft");
    expect(saveDraftBlock).not.toContain("import_status");
    expect(saveDraftBlock).not.toContain("audit(");
  });
});

describe("import route: returns the inserted batch's purchase ids for targeted export", () => {
  it("still requires explicit confirmation", () => {
    expect(importSource).toContain("z.literal(true)");
  });

  it("collects and returns insertedIds alongside the existing response fields", () => {
    expect(importSource).toContain("insertedIds");
    expect(importSource).toContain("insertedIds.push(...rows.map(r => r.purchase_id))");
  });
});

describe("import route: REGRESSION — calls the transactional RPC once per order group instead of inserting each row itself", () => {
  it("groups submitted records by their candidate's source email (yahoo_message_id) before importing", () => {
    expect(importSource).toContain("candidate.yahoo_message_id");
    expect(importSource).toContain("groups.set(candidate.yahoo_message_id, group)");
  });

  it("calls rpc/import_purchase_order once per group, passing only candidate_id and the confirmed/edited fields", () => {
    expect(importSource).toContain('"rpc/import_purchase_order"');
    expect(importSource).toContain("p_owner_id: user.id");
    expect(importSource).toContain("p_records");
  });

  it("never inserts directly into purchases or patches a candidate's import_status itself — the RPC owns both", () => {
    expect(importSource).not.toMatch(/supabaseRequest\("purchases"/);
    expect(importSource).not.toContain('import_status: "imported"');
  });

  it("only sends candidates that are still pending (not already imported, rejected, or a seller notification) to any group", () => {
    expect(importSource).toContain('x.import_status === "pending"');
    expect(importSource).toContain("!x.imported_purchase_id");
    expect(importSource).toContain("!sellerNotice(x.subject)");
  });
});

describe("import route: REGRESSION — an order must be imported all-or-nothing, never a partial selection", () => {
  it("fetches every still-pending, importable (not cancelled/refunded) sibling for each order group before calling the RPC", () => {
    expect(importSource).toContain("import_status=eq.pending&cancellation_refund_status=is.null&select=id,yahoo_message_id");
  });

  it("blocks a group as an incomplete selection, and never calls the RPC for it, when the submitted ids don't exactly match the full sibling set", () => {
    const loop = importSource.slice(importSource.indexOf("for (const [messageId, group] of groups)"), importSource.indexOf('"rpc/import_purchase_order"'));
    expect(loop).toContain("isCompleteSelection");
    expect(loop).toMatch(/if \(!isCompleteSelection\)\s*\{\s*blocked \+= group\.length; blockedReasons\.add\("incomplete_selection"\); continue; \}/);
  });

  it("the completeness check is a true set-equality comparison (same size and every required id present), not just a count comparison", () => {
    expect(importSource).toContain("required.size === submitted.size && [...required].every(id => submitted.has(id))");
  });
});

describe("import route: REGRESSION — the order-total invariant is enforced server-side, not just warned about in the browser", () => {
  it("fetches every sibling's own order_total_paid, never trusting a single candidate row's value", () => {
    expect(importSource).toContain("select=id,yahoo_message_id,order_total_paid");
  });

  it("checks the exact rows being imported against matchesOrderTotal (the same pence-exact comparison the RPC performs) before ever calling the RPC", () => {
    expect(importSource).toContain('import { matchesOrderTotal, hasConsistentOrderTotal, sharedOrderTotal } from "@/lib/purchase-import/order-total"');
    const loop = importSource.slice(importSource.indexOf("for (const [messageId, group] of groups)"), importSource.indexOf('"rpc/import_purchase_order"'));
    expect(loop).toContain("matchesOrderTotal(group.map(g => g.purchase.price_purchased), orderTotal)");
  });

  it("REGRESSION: a mismatched group is blocked with its own distinct reason and never reaches the RPC — zero purchases inserted, zero candidate statuses changed", () => {
    const loop = importSource.slice(importSource.indexOf("for (const [messageId, group] of groups)"), importSource.indexOf('"rpc/import_purchase_order"'));
    expect(loop).toMatch(/if \(!matchesOrderTotal\(/);
    expect(loop).toContain('blocked += group.length; blockedReasons.add("order_total_mismatch"); continue;');
    // The block must return/continue before the RPC call further down —
    // i.e. this check's block appears strictly before the try/RPC section.
    expect(loop.indexOf('blockedReasons.add("order_total_mismatch")')).toBeLessThan(loop.indexOf("const p_records"));
  });

  it("never rebalances or alters submitted prices to force a match", () => {
    expect(importSource).not.toMatch(/purchase\.price_purchased\s*=/);
  });
});

describe("import route: REGRESSION — inconsistent sibling order totals reject the whole group rather than one value silently winning", () => {
  it("checks the FULL sibling set via hasConsistentOrderTotal, not a single row's own order_total_paid", () => {
    const loop = importSource.slice(importSource.indexOf("for (const [messageId, group] of groups)"), importSource.indexOf('"rpc/import_purchase_order"'));
    expect(loop).toContain("hasConsistentOrderTotal(siblingTotals)");
    expect(loop).toContain("sharedOrderTotal(siblingTotals)");
  });

  it("blocks with a distinct 'inconsistent_order_total' reason, before the completeness or total-match checks, and never calls the RPC", () => {
    const loop = importSource.slice(importSource.indexOf("for (const [messageId, group] of groups)"), importSource.indexOf('"rpc/import_purchase_order"'));
    expect(loop).toContain('blocked += group.length; blockedReasons.add("inconsistent_order_total"); continue;');
    expect(loop.indexOf('blockedReasons.add("inconsistent_order_total")')).toBeLessThan(loop.indexOf('blockedReasons.add("incomplete_selection")'));
  });
});

describe("import route: REGRESSION — every submitted price must be an exact whole-penny amount before any total comparison or insert", () => {
  it("validates price_purchased with the shared, testable isWholePennyAmount helper, in addition to non-negativity", () => {
    expect(importSource).toContain('import { isWholePennyAmount } from "@/lib/purchase-import/pence"');
    expect(importSource).toContain("z.coerce.number().nonnegative().refine(isWholePennyAmount");
  });

  it("this validation happens in the request schema itself, so a malformed price is rejected before any candidate lookup or grouping", () => {
    const schemaIndex = importSource.indexOf("const editSchema");
    const refineIndex = importSource.indexOf("refine(isWholePennyAmount");
    const firstLookupIndex = importSource.indexOf("await requireOwner()");
    expect(refineIndex).toBeGreaterThan(schemaIndex);
    expect(refineIndex).toBeLessThan(firstLookupIndex);
  });
});

describe("import route: REGRESSION — only a known candidate-state conflict is ever counted as blocked; an unexpected error fails the whole request instead of being silently absorbed", () => {
  it("classifies each RPC failure via the shared, testable classifyRpcError helper rather than treating every failure the same way", () => {
    expect(importSource).toContain("import { classifyRpcError } from \"@/lib/purchase-import/rpc-errors\"");
    expect(importSource).toContain("classifyRpcError(error)");
  });

  it("rethrows (never swallows) an unrecognized RPC error instead of counting it as a duplicate/blocked group", () => {
    const catchBlock = importSource.slice(importSource.indexOf("} catch (error) {", importSource.indexOf("rpc/import_purchase_order")), importSource.indexOf("await audit(user.id, \"import_confirmed\""));
    expect(catchBlock).toContain("if (!reason) throw error;");
    expect(catchBlock).not.toMatch(/duplicates \+= group\.length/);
  });

  it("a recognized conflict increments a distinct 'blocked' counter, never the pre-existing 'duplicates' counter", () => {
    const catchBlock = importSource.slice(importSource.indexOf("} catch (error) {", importSource.indexOf("rpc/import_purchase_order")), importSource.indexOf("await audit(user.id, \"import_confirmed\""));
    expect(catchBlock).toContain("blocked += group.length; blockedReasons.add(reason);");
  });

  it("returns blocked/blockedReasons in the response alongside the existing fields", () => {
    expect(importSource).toContain("blocked, blockedReasons: [...blockedReasons]");
  });

  it("an unhandled thrown error still reaches the outer safeApiError handler, which never exposes raw error text or secrets", () => {
    expect(importSource).toContain('return safeApiError(error, "Purchase import could not be completed safely.")');
  });
});

describe("export route: a just-approved batch can be exported by id, without pulling in unrelated history", () => {
  it("accepts an ?ids= mode as an alternative to the date-range mode", () => {
    expect(exportSource).toContain('searchParams.get("ids")');
    expect(exportSource).toContain("id=in.(");
  });

  it("still supports the original start/end date-range export unchanged", () => {
    expect(exportSource).toContain('searchParams.get("start")');
    expect(exportSource).toContain('searchParams.get("end")');
  });

  it("validates ids strictly (uuid) rather than interpolating raw user input into the query", () => {
    expect(exportSource).toContain("z.string().uuid()");
  });
});

describe("REGRESSION: no tokens or email bodies enter exported files or audit metadata", () => {
  it("the exported spreadsheet is built only from the fixed, agreed 8-column list — new internal-only columns added this round are never referenced by it", () => {
    const exportColumnsSource = readFileSync("lib/exportColumns.ts", "utf8");
    for (const internalField of ["source_item_key", "draft", "item_condition_hint", "source_provider", "source_account", "vinted_fingerprint", "vinted_order_reference", "vinted_candidate_id"]) {
      expect(exportColumnsSource).not.toContain(internalField);
    }
  });

  it("every audit() call across the sync/candidates/import routes logs only counts, scopes and ids — never raw subject/sender/excerpt/token fields", () => {
    for (const source of [syncSource, candidatesSource, importSource]) {
      const calls = source.match(/await audit\(user\.id,[\s\S]*?\);/g) || [];
      for (const call of calls) {
        expect(call).not.toMatch(/\b(sanitized_excerpt|subject|sender|access_token|refresh_token|body|text)\s*:/);
      }
    }
  });
});
