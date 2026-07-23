import { NextResponse } from "next/server"; import { z } from "zod"; import { requireOwner } from "@/lib/auth/server"; import { safeApiError } from "@/lib/auth/api"; import { conditions, purchaseInputSchema } from "@/lib/validation/purchase"; import { supabaseRequest } from "@/lib/supabase"; import { audit, enforceRateLimit } from "@/lib/security/activity"; import { classifyRpcError } from "@/lib/purchase-import/rpc-errors"; import { matchesOrderTotal, hasConsistentOrderTotal, sharedOrderTotal } from "@/lib/purchase-import/order-total"; import { isWholePennyAmount } from "@/lib/purchase-import/pence";
// REGRESSION: price_purchased must be an exact whole-penny amount — the app
// rounds each row individually while the RPC rounds only the combined
// total, so a fractional-penny value here could pass one layer's check
// while disagreeing with the other's. Rejected before any total comparison
// or insert (see also rpc/import_purchase_order's own INVALID_PRICE_PRECISION check).
const editSchema = z.object({ candidateId: z.string().uuid(), purchased_from: z.string().trim().min(1).max(100), sku: z.string().trim().max(100), item_description: z.string().trim().min(1), seller_name: z.string().trim().max(200), item_size: z.string().trim().min(1), item_condition: z.enum(conditions), price_purchased: z.coerce.number().nonnegative().refine(isWholePennyAmount, "Price must be a whole-penny amount (no more than 2 decimal places)."), order_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), arrived: z.boolean().nullable().default(null) }).strict();
const importSchema = z.object({ confirmed: z.literal(true), records: z.array(editSchema).min(1).max(100) }).strict();
// order_total_paid is deliberately NOT read from this per-candidate fetch —
// it's duplicated across every sibling row of an order, and the only safe
// source of truth for it is the consistency-checked siblingOrderTotals map
// built below (see the INCONSISTENT_ORDER_TOTAL check), never a single
// candidate row's own (possibly stale-relative-to-its-siblings) value.
type Candidate = { id: string; subject: string; import_status: string; imported_purchase_id: string | null; order_reference: string | null; fingerprint: string; purchased_from: string | null; candidate_type: string; yahoo_message_id: string };

export async function POST(request: Request) { try { const user = await requireOwner(); await enforceRateLimit(user.id, "purchase_email_import", 5, 300); const { records } = importSchema.parse(await request.json()); const ids = records.map(x => x.candidateId);
    const candidates = await (await supabaseRequest(`vinted_import_candidates?owner_id=eq.${user.id}&id=in.(${ids.join(",")})&select=id,subject,import_status,imported_purchase_id,order_reference,fingerprint,purchased_from,candidate_type,yahoo_message_id`)).json() as Candidate[];
    const sellerNotice = (subject: string) => /(?:you(?:'|’)?ve sold an item|your item (?:has )?sold|item sold on vinted)/i.test(subject);
    // Only candidates still genuinely pending are eligible — anything already
    // imported, rejected, or a seller notification is excluded up front so a
    // single bad sibling can never drag an otherwise-valid order group's RPC
    // call into failing (the RPC itself re-checks pending status too, as a
    // second, authoritative gate against a race with another request).
    const available = new Map(candidates.filter(x => x.import_status === "pending" && !x.imported_purchase_id && !sellerNotice(x.subject)).map(x => [x.id, x]));
    let duplicates = records.filter(x => !available.has(x.candidateId)).length; let inserted = 0; let blocked = 0; let total = 0; const insertedIds: string[] = []; const blockedReasons = new Set<string>();

    // Group by order (one source email = one order group) — the RPC is
    // called once per group, never once per row, so a failure in one order
    // never touches another's rows, and every row belonging to the same
    // order either all lands or none does.
    const groups = new Map<string, { candidate: Candidate; purchase: z.infer<typeof purchaseInputSchema>; candidateId: string }[]>();
    for (const record of records) {
      const candidate = available.get(record.candidateId); if (!candidate) continue;
      const purchase = purchaseInputSchema.parse({ order_date: record.order_date, purchased_from: record.purchased_from || candidate.purchased_from || (candidate.candidate_type === "vinted" ? "Vinted" : "Unknown retailer"), seller_name: record.seller_name || null, sku: record.sku, item_description: record.item_description, item_size: record.item_size, quantity: 1, item_condition: record.item_condition, price_purchased: record.price_purchased, arrived: record.arrived });
      const group = groups.get(candidate.yahoo_message_id) || []; group.push({ candidate, purchase, candidateId: record.candidateId }); groups.set(candidate.yahoo_message_id, group);
    }

    // REGRESSION: an order must be imported all-or-nothing. Before calling
    // the RPC for any group, confirm the submitted candidate ids are
    // EXACTLY this order's full set of still-pending, importable (not
    // cancelled/refunded) siblings — never a subset. This is the
    // server-side half of the guarantee; rpc/import_purchase_order enforces
    // the identical rule again, authoritatively, inside its own transaction
    // (Pass 1.5) — this check exists to fail fast with a clear reason, never
    // to replace the database-side one.
    const messageIds = [...groups.keys()];
    const completeSiblingIds = new Map<string, Set<string>>();
    const siblingOrderTotals = new Map<string, (number | null)[]>();
    if (messageIds.length) {
      const quoted = messageIds.map(id => `"${id.replace(/"/g, '\\"')}"`).join(",");
      const siblingRows = await (await supabaseRequest(`vinted_import_candidates?owner_id=eq.${user.id}&yahoo_message_id=in.(${quoted})&import_status=eq.pending&cancellation_refund_status=is.null&select=id,yahoo_message_id,order_total_paid`)).json() as { id: string; yahoo_message_id: string; order_total_paid: number | null }[];
      for (const row of siblingRows) {
        if (!completeSiblingIds.has(row.yahoo_message_id)) completeSiblingIds.set(row.yahoo_message_id, new Set());
        completeSiblingIds.get(row.yahoo_message_id)!.add(row.id);
        const totals = siblingOrderTotals.get(row.yahoo_message_id) || []; totals.push(row.order_total_paid); siblingOrderTotals.set(row.yahoo_message_id, totals);
      }
    }

    for (const [messageId, group] of groups) {
      // REGRESSION: order_total_paid is duplicated on every sibling row of
      // the same order — hasConsistentOrderTotal checks the FULL sibling
      // set at once, rather than trusting any single row's own value (e.g.
      // via a SQL max()), which would silently pick one value if the
      // siblings ever disagreed with each other.
      const siblingTotals = siblingOrderTotals.get(messageId) || [];
      if (!hasConsistentOrderTotal(siblingTotals)) { blocked += group.length; blockedReasons.add("inconsistent_order_total"); continue; }
      const orderTotal = sharedOrderTotal(siblingTotals);

      const required = completeSiblingIds.get(messageId) || new Set<string>();
      const submitted = new Set(group.map(g => g.candidateId));
      const isCompleteSelection = required.size === submitted.size && [...required].every(id => submitted.has(id));
      if (!isCompleteSelection) { blocked += group.length; blockedReasons.add("incomplete_selection"); continue; }

      // REGRESSION: the browser already warns on a mismatched allocation,
      // but neither this route nor the database enforced it — a reviewer
      // could still submit prices that don't sum to the order's own stored
      // total. matchesOrderTotal compares in exact integer pence (never
      // floating point) and mirrors the RPC's own Pass 1.5 check exactly;
      // a null order_total_paid (never confidently extracted) is not
      // enforced. Never rebalances/alters the submitted prices — a
      // mismatch simply blocks the whole group, same as an incomplete
      // selection, before the RPC (and any insert) is ever called.
      if (!matchesOrderTotal(group.map(g => g.purchase.price_purchased), orderTotal)) {
        blocked += group.length; blockedReasons.add("order_total_mismatch"); continue;
      }

      // vinted_order_reference/vinted_fingerprint/source_item_key are looked
      // up server-side from the locked candidate row inside the RPC, not
      // trusted from this payload — only candidate_id and the
      // reviewer-edited/confirmed fields are sent.
      const p_records = group.map(({ purchase, candidateId }) => ({ candidate_id: candidateId, order_date: purchase.order_date, purchased_from: purchase.purchased_from, seller_name: purchase.seller_name, sku: purchase.sku, item_description: purchase.item_description, item_size: purchase.item_size, item_condition: purchase.item_condition, price_purchased: purchase.price_purchased, arrived: purchase.arrived }));
      try {
        const response = await supabaseRequest("rpc/import_purchase_order", { method: "POST", body: JSON.stringify({ p_owner_id: user.id, p_records }) });
        const rows = await response.json() as { purchase_id: string; source_item_key: string }[];
        inserted += group.length; total += group.reduce((sum, g) => sum + g.purchase.price_purchased, 0); insertedIds.push(...rows.map(r => r.purchase_id));
      } catch (error) {
        // Only a recognized candidate-state conflict (see KNOWN_CONFLICTS)
        // is ever treated as "this group couldn't be imported right now".
        // Anything else — a missing migration/function, malformed input, a
        // database outage, a permission problem, or any other programming
        // error — is genuinely unexpected and must fail the whole request
        // safely and visibly (via safeApiError below, which never exposes
        // raw error text or secrets) rather than being silently counted as
        // a duplicate.
        const reason = classifyRpcError(error);
        if (!reason) throw error;
        blocked += group.length; blockedReasons.add(reason);
      }
    }

    await audit(user.id, "import_confirmed", { requested: records.length, inserted, duplicates, blocked, total: total.toFixed(2) }); return NextResponse.json({ inserted, duplicates, blocked, blockedReasons: [...blockedReasons], total: total.toFixed(2), currency: "GBP", insertedIds }, { status: inserted ? 201 : 200 });
  } catch (error) { return safeApiError(error, "Purchase import could not be completed safely."); } }
