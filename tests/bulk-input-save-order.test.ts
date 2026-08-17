import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync("app/api/purchases/bulk/route.ts", "utf8");
const purchasesRouteSource = readFileSync("app/api/purchases/route.ts", "utf8");

describe("bulk purchase save order", () => {
  it("assigns a deterministic descending created_at sequence in preview order", () => {
    expect(routeSource).toContain("const batchCreatedAt = Date.now();");
    expect(routeSource).toContain("created_at: new Date(batchCreatedAt - index).toISOString(),");
  });

  it("uses created_at as the database tie-breaker for equal order dates", () => {
    expect(purchasesRouteSource).toContain("order=order_date.desc,created_at.desc");
  });
});
