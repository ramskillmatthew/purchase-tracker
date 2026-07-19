import { NextResponse } from "next/server";
import { supabaseRequest } from "@/lib/supabase";

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
    const payload = await request.json();
    const rows: BulkRow[] = Array.isArray(payload.rows) ? payload.rows : [];
    if (!rows.length || rows.length > 500) return NextResponse.json({ error: "Submit between 1 and 500 purchases." }, { status: 400 });

    const failures: { row: number; reason: string }[] = [];
    const valid = rows.flatMap((row, index) => {
      const price = Number(row.price_purchased);
      const missing = [!row.sku?.trim() && "SKU", !row.item_description?.trim() && "Item Description", !Number.isFinite(price) && "Price Purchased"].filter(Boolean);
      if (missing.length) {
        failures.push({ row: index + 1, reason: `Missing or invalid ${missing.join(", ")}` });
        return [];
      }
      return [{
        id: row.id,
        order_date: row.order_date || null,
        purchased_from: row.purchased_from?.trim() || null,
        seller_name: row.seller_name?.trim() || null,
        sku: row.sku!.trim(),
        item_description: row.item_description!.trim(),
        item_size: row.item_size?.trim() || null,
        quantity: 1,
        item_condition: row.item_condition?.trim() || null,
        price_purchased: price,
        arrived: row.arrived ?? null,
      }];
    });

    if (!valid.length) return NextResponse.json({ added: 0, failures }, { status: 400 });
    await supabaseRequest("purchases", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(valid) });
    return NextResponse.json({ added: valid.length, failures }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save bulk purchases." }, { status: 500 });
  }
}
