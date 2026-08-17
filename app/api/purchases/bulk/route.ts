import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";
import { requireOwner } from "@/lib/auth/server";
import { safeApiError } from "@/lib/auth/api";
import { parseUkDate } from "@/lib/validation/uk-date";

type BulkRow = {
  id?: string;
  order_date?: string | null;
  purchased_from?: string | null;
  seller_name?: string | null;
  sku?: string;
  item_description?: string;
  item_size?: string | null;
  item_condition?: string | null;
  price_purchased?: number;
  arrived?: boolean | null;
};

export async function POST(request: Request) {
  try {
    await requireOwner();
    const payload = await request.json();
    const rows: BulkRow[] = Array.isArray(payload.rows) ? payload.rows : [];
    if (!rows.length || rows.length > 500) return NextResponse.json({ error: "Submit between 1 and 500 purchases." }, { status: 400 });

    const failures: { row: number; reason: string }[] = [];
    // PostgREST inserts an array in one statement, so every row otherwise
    // receives the same `now()` value from the database default. The
    // Purchases page orders equal order dates by created_at descending; a
    // shared timestamp therefore leaves those rows in an undefined order.
    // Give earlier preview rows slightly newer timestamps so the database
    // tie-breaker reproduces the user's top-to-bottom input order. The
    // widest allowed batch spans less than half a second.
    const batchCreatedAt = Date.now();
    const valid = rows.flatMap((row, index) => {
      const price = Number(row.price_purchased);
      const missing = [!row.sku?.trim() && "SKU", !row.item_description?.trim() && "Item Description", !Number.isFinite(price) && "Price Purchased"].filter(Boolean);
      if (missing.length) {
        failures.push({ row: index + 1, reason: `Missing or invalid ${missing.join(", ")}` });
        return [];
      }
      let orderDate: string | null = null;
      if (row.order_date && row.order_date.trim()) {
        const parsed = parseUkDate(row.order_date);
        if (!parsed.ok) {
          failures.push({ row: index + 1, reason: `Order date row ${index + 1}: ${parsed.error}` });
          return [];
        }
        orderDate = parsed.iso;
      }
      return [{
        id: row.id,
        order_date: orderDate,
        purchased_from: row.purchased_from?.trim() || null,
        seller_name: row.seller_name?.trim() || null,
        sku: row.sku!.trim(),
        item_description: row.item_description!.trim(),
        item_size: row.item_size?.trim() || null,
        quantity: 1,
        item_condition: row.item_condition?.trim() || null,
        price_purchased: price,
        arrived: row.arrived ?? null,
        created_at: new Date(batchCreatedAt - index).toISOString(),
      }];
    });

    if (!valid.length) return NextResponse.json({ added: 0, failures }, { status: 400 });
    await supabaseRequest("purchases", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(valid) });
    return NextResponse.json({ added: valid.length, failures }, { status: 201 });
  } catch (error) { return safeApiError(error, "Could not save bulk purchases."); }
}
