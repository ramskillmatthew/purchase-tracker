import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseRequest } from "@/lib/supabase";
import type { Purchase } from "@/lib/types";

export default async function PurchaseRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const response = await supabaseRequest(`purchases?id=eq.${encodeURIComponent(id)}&select=*`);
  const [purchase] = await response.json() as Purchase[];
  if (!purchase) notFound();

  const details = [
    ["Order Date", purchase.order_date],
    ["Purchased From", purchase.purchased_from],
    ["Seller Name", purchase.seller_name],
    ["SKU", purchase.sku],
    ["Item Description", purchase.item_description],
    ["Item Size", purchase.item_size],
    ["Quantity", purchase.quantity],
    ["Item Condition", purchase.item_condition],
    ["Price Purchased", `£${Number(purchase.price_purchased).toFixed(2)}`],
  ];

  return <section className="mx-auto max-w-2xl space-y-7">
    <div><Link href="/purchases" className="text-sm font-medium text-blue-600">← Back to Purchases</Link><h1 className="mt-4 text-3xl font-bold tracking-tight">Purchase Record</h1></div>
    <dl className="card divide-y divide-zinc-100 px-5 sm:px-7">{details.map(([label, value]) => <div key={String(label)} className="grid gap-1 py-4 sm:grid-cols-[180px_1fr]"><dt className="text-sm font-medium text-zinc-500">{label}</dt><dd className="font-medium">{value || "—"}</dd></div>)}</dl>
  </section>;
}
