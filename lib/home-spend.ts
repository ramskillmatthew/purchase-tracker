import type { Purchase } from "@/lib/types";

export type HomeSpendCategory = "Pokémon" | "Non-Pokémon TCG" | "Clothing" | "Footwear" | "Other";

const footwear = /\b(trainer|trainers|shoe|shoes|boot|boots|sneaker|sneakers|nike|adidas|new balance|on running|cloud\w*|hoka|merrell|asics|reebok|puma|jordan|vans|converse|timberland|salomon|saucony)\b/i;
const pokemon = /\b(pok[eé]mon|pikachu|charizard|greninja|sylveon|elite trainer box|\betb\b|prismatic evolutions|surging sparks|destined rivals|journey together)\b/i;
const otherTcg = /\b(one piece|\bop[- ]?\d{1,2}\b|booster box|booster pack|trading card|\btcg\b|lorcana|yugioh|yu-gi-oh|magic the gathering|\bmtg\b)\b/i;
const clothing = /\b(t-?shirt|shirt|hoodie|jacket|coat|trouser|trousers|jean|jeans|shorts|tracksuit|dress|jumper|sweater|fleece|sweatshirt|top|jersey|gilet|clothing|apparel)\b/i;

export function homeSpendCategory(purchase: Pick<Purchase, "category" | "item_description">): HomeSpendCategory {
  const category = purchase.category?.trim();
  if (category && category !== "Other") return category as HomeSpendCategory;
  const description = purchase.item_description ?? "";
  if (pokemon.test(description)) return "Pokémon";
  if (otherTcg.test(description)) return "Non-Pokémon TCG";
  if (footwear.test(description)) return "Footwear";
  if (clothing.test(description)) return "Clothing";
  return "Other";
}

export function homeSpendBreakdown(purchases: readonly Purchase[]) {
  const grouped = new Map<HomeSpendCategory, number>();
  for (const purchase of purchases) {
    const category = homeSpendCategory(purchase);
    grouped.set(category, (grouped.get(category) ?? 0) + Number(purchase.price_purchased || 0));
  }
  const total = [...grouped.values()].reduce((sum, value) => sum + value, 0);
  const palette: Record<HomeSpendCategory, string> = {
    Footwear: "#704dff",
    Pokémon: "#1aa6ff",
    "Non-Pokémon TCG": "#1ee69e",
    Clothing: "#ffcc25",
    Other: "#ff7f66",
  };
  const rows = [...grouped].sort((a, b) => b[1] - a[1]);
  const visible = rows.slice(0, 4);
  if (rows.length > 4) {
    const remainder = rows.slice(4).reduce((sum, row) => sum + row[1], 0);
    const existingOther = visible.findIndex(([name]) => name === "Other");
    if (existingOther >= 0) visible[existingOther] = ["Other", visible[existingOther][1] + remainder];
    else visible.push(["Other", remainder]);
  }
  return { total, rows: visible.map(([name, value]) => ({ name, value, color: palette[name], percentage: total ? value / total * 100 : 0 })) };
}
