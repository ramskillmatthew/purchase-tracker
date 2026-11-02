import { describe, expect, it } from "vitest";
import { homeSpendBreakdown, homeSpendCategory } from "@/lib/home-spend";
import type { Purchase } from "@/lib/types";

function purchase(item_description: string, price_purchased: number, category = "Other"): Purchase {
  return { id: item_description, order_date: "2026-10-01", purchased_from: "shop", seller_name: "", sku: item_description, item_description, item_size: "", quantity: 1, item_condition: "Brand new", category, price_purchased, arrived: true, stock_status: "in_stock", created_at: "2026-10-01T00:00:00Z" };
}

describe("home spending categories", () => {
  it("recognises footwear imported with the legacy Other category", () => {
    expect(homeSpendCategory(purchase("New Balance 530 silver navy", 30))).toBe("Footwear");
    expect(homeSpendCategory(purchase("On Running Cloud 5", 40))).toBe("Footwear");
  });

  it("separates Pokémon and other trading cards", () => {
    expect(homeSpendCategory(purchase("Pokemon Prismatic Evolutions ETB", 50))).toBe("Pokémon");
    expect(homeSpendCategory(purchase("One Piece OP-17 booster box", 80))).toBe("Non-Pokémon TCG");
  });

  it("keeps an explicitly assigned category", () => {
    expect(homeSpendCategory(purchase("Mystery item", 15, "Clothing"))).toBe("Clothing");
  });

  it("reconciles the visible breakdown to the purchase total", () => {
    const breakdown = homeSpendBreakdown([purchase("Nike trainers", 20), purchase("Pokemon tin", 30), purchase("Unknown", 10)]);
    expect(breakdown.total).toBe(60);
    expect(breakdown.rows.reduce((sum, row) => sum + row.value, 0)).toBe(60);
  });
});
