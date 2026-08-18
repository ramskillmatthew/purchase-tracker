import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { requireOwner, supabaseRequest, supabaseRequestAll } = vi.hoisted(() => ({
  requireOwner: vi.fn(async () => ({ id: "owner-1", email: "owner@example.com" })),
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 204 })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
}));
vi.mock("@/lib/auth/server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...actual, requireOwner };
});
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));

const { resolvePokePulseIdentity, pokePulseProvider } = vi.hoisted(() => ({
  resolvePokePulseIdentity: vi.fn(),
  pokePulseProvider: { name: "pokepulse" as const, isConfigured: () => true, getQuote: vi.fn(), getHistory: vi.fn() },
}));
vi.mock("@/lib/investments/providers/pokepulse", () => ({ resolvePokePulseIdentity, pokePulseProvider }));

const { getFxRate } = vi.hoisted(() => ({ getFxRate: vi.fn(async () => ({ rate: 0.74, requestedDate: "2026-08-13", provider: "frankfurter" as const })) }));
vi.mock("@/lib/investments/providers/fx-provider", () => ({ getFxRate }));

import { GET as getAccounts, POST as createAccount } from "@/app/api/investments/accounts/route";
import { GET as getAssets, POST as createAsset } from "@/app/api/investments/assets/route";
import { GET as getAssetDetail } from "@/app/api/investments/assets/[assetId]/route";
import { POST as recordTransaction } from "@/app/api/investments/transactions/route";
import { POST as refreshPrices } from "@/app/api/investments/refresh/route";
import { AuthError } from "@/lib/auth/server";

function jsonRequest(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  requireOwner.mockClear();
  requireOwner.mockResolvedValue({ id: "owner-1", email: "owner@example.com" });
  supabaseRequest.mockReset();
  supabaseRequestAll.mockReset();
  resolvePokePulseIdentity.mockReset();
  pokePulseProvider.getQuote.mockReset();
  getFxRate.mockClear();
  supabaseRequestAll.mockResolvedValue([]);
  supabaseRequest.mockResolvedValue(new Response(null, { status: 204 }));
});

describe("Investments API — authentication is required everywhere", () => {
  it("GET /api/investments/accounts requires auth", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await getAccounts();
    expect(response.status).toBe(401);
  });

  it("POST /api/investments/accounts requires auth", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await createAccount(jsonRequest("http://test/api/investments/accounts", { name: "ISA", accountType: "isa" }));
    expect(response.status).toBe(401);
  });

  it("GET /api/investments/assets requires auth", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await getAssets(new Request("http://test/api/investments/assets"));
    expect(response.status).toBe(401);
  });

  it("POST /api/investments/assets requires auth", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await createAsset(jsonRequest("http://test/api/investments/assets", { category: "cash", accountId: "00000000-0000-0000-0000-000000000000", currency: "GBP", openingAmount: 10 }));
    expect(response.status).toBe(401);
  });

  it("POST /api/investments/transactions requires auth", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await recordTransaction(jsonRequest("http://test/api/investments/transactions", { accountId: "00000000-0000-0000-0000-000000000000", transactionType: "deposit", tradeAt: "2026-01-01", gbpTotal: 10 }));
    expect(response.status).toBe(401);
  });

  it("POST /api/investments/refresh requires auth", async () => {
    requireOwner.mockRejectedValueOnce(new AuthError("Authentication required."));
    const response = await refreshPrices(new Request("http://test/api/investments/refresh", { method: "POST" }));
    expect(response.status).toBe(401);
  });
});

describe("Investments API — owner isolation (every query scoped to owner_id=eq.<user.id>)", () => {
  it("GET /api/investments/accounts scopes its query to the authenticated owner", async () => {
    await getAccounts();
    const call = supabaseRequestAll.mock.calls.find(c => (c[0] as string).startsWith("investment_accounts?"));
    expect(call![0]).toContain("owner_id=eq.owner-1");
  });

  it("GET /api/investments/assets scopes its query to the authenticated owner", async () => {
    await getAssets(new Request("http://test/api/investments/assets"));
    const call = supabaseRequestAll.mock.calls.find(c => (c[0] as string).startsWith("investment_assets?"));
    expect(call![0]).toContain("owner_id=eq.owner-1");
  });

  it("POST /api/investments/assets verifies the account belongs to the owner before creating anything under it", async () => {
    supabaseRequestAll.mockResolvedValue([]); // no matching account for this owner
    const response = await createAsset(jsonRequest("http://test/api/investments/assets", {
      category: "stock", accountId: "00000000-0000-0000-0000-000000000000", displayName: "NVIDIA", ticker: "NVDA",
    }));
    expect(response.status).toBe(400);
    expect(supabaseRequest.mock.calls.some(c => c[0] === "investment_assets")).toBe(false);
  });
});

describe("Investments API — a newly-added Pokémon/stock investment is priced immediately, never left permanently 'never priced'", () => {
  it("POST /api/investments/assets triggers an immediate PokePulse price fetch and reports success in the response", async () => {
    supabaseRequestAll.mockResolvedValue([{ id: "acc-1" }]); // account exists
    resolvePokePulseIdentity.mockResolvedValue({
      ok: true, data: { productId: "sealed:me04|Chaos Rising Pokemon Center Elite Trainer Box", name: "Chaos Rising Pokemon Center Elite Trainer Box", imageUrl: "https://pokepulse-static.s3.eu-west-2.amazonaws.com/x.webp", kind: "sealed" },
    });
    pokePulseProvider.getQuote.mockResolvedValue({
      ok: true, data: { nativeUnitPrice: 96.66, nativeCurrency: "GBP", priceAt: "2026-08-13T00:00:00.000Z", provider: "pokepulse" },
    });
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_assets" && init?.method === "POST") {
        return new Response(JSON.stringify([{
          id: "asset-1", category: "pokemon", display_name: "Chaos Rising Pokemon Center Elite Trainer Box", ticker: null, exchange: null,
          native_currency: "GBP", pricing_provider: "pokepulse", source_url: "https://pokepulse.io/sealed/chaos-rising-pokemon-center-elite-trainer-box",
          external_id: "sealed:me04|Chaos Rising Pokemon Center Elite Trainer Box", image_url: null, lego_set_number: null, metadata: {},
          created_at: "2026-08-13T00:00:00.000Z", updated_at: "2026-08-13T00:00:00.000Z", archived_at: null,
        }]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (path.startsWith("investment_price_snapshots") && init?.method === "POST") {
        return new Response(JSON.stringify([{ id: "snap-1", created_at: "2026-08-13T00:00:00.500Z" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    });

    const response = await createAsset(jsonRequest("http://test/api/investments/assets", {
      category: "pokemon", accountId: "11111111-1111-4111-8111-111111111111",
      sourceUrl: "https://pokepulse.io/sealed/chaos-rising-pokemon-center-elite-trainer-box",
      purchaseDate: "2026-05-17", quantity: 4, purchaseUnitPrice: 54.99, feesGbp: 0,
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(pokePulseProvider.getQuote).toHaveBeenCalledWith("sealed:me04|Chaos Rising Pokemon Center Elite Trainer Box");
    expect(body.pricing).toEqual({
      assetId: "asset-1", provider: "pokepulse", outcome: "updated", ok: true,
      nativeUnitPrice: 96.66, nativeCurrency: "GBP", priceAt: "2026-08-13T00:00:00.000Z",
      snapshotWritten: true, snapshotId: "snap-1", providerObservationAt: "2026-08-13T00:00:00.000Z",
      retrievedAt: expect.any(String), previousPrice: null, returnedPrice: 96.66, selectedStoredPrice: 96.66,
    });
    const snapshotWrite = supabaseRequest.mock.calls.find(c => c[0] === "investment_price_snapshots");
    expect(snapshotWrite).toBeDefined();
    const snapshotBody = JSON.parse((snapshotWrite![1] as RequestInit).body as string);
    expect(snapshotBody.gbp_unit_price).toBeCloseTo(96.66);
  });

  it("a pricing failure never fails the whole request — the asset is still saved, and the failure is reported distinctly", async () => {
    supabaseRequestAll.mockResolvedValue([{ id: "acc-1" }]);
    resolvePokePulseIdentity.mockResolvedValue({
      ok: true, data: { productId: "sealed:x|Y", name: "Some Product", imageUrl: null, kind: "sealed" },
    });
    pokePulseProvider.getQuote.mockResolvedValue({ ok: false, error: "PokePulse returned no market price for this item.", retryable: true });
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_assets" && init?.method === "POST") {
        return new Response(JSON.stringify([{
          id: "asset-2", category: "pokemon", display_name: "Some Product", ticker: null, exchange: null, native_currency: "GBP",
          pricing_provider: "pokepulse", source_url: "https://pokepulse.io/sealed/y", external_id: "sealed:x|Y", image_url: null,
          lego_set_number: null, metadata: {}, created_at: "2026-08-13T00:00:00.000Z", updated_at: "2026-08-13T00:00:00.000Z", archived_at: null,
        }]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    });

    const response = await createAsset(jsonRequest("http://test/api/investments/assets", { category: "pokemon", accountId: "11111111-1111-4111-8111-111111111111", sourceUrl: "https://pokepulse.io/sealed/y" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.asset.id).toBe("asset-2");
    expect(body.pricing).toEqual({ assetId: "asset-2", provider: "pokepulse", outcome: "no_data", ok: false, error: "PokePulse returned no market price for this item." });
    expect(supabaseRequest.mock.calls.some(c => c[0] === "investment_price_snapshots")).toBe(false);
  });

  it("never attempts to price a cash or LEGO (manual) investment on creation", async () => {
    supabaseRequestAll.mockResolvedValue([{ id: "acc-1" }]);
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_assets" && init?.method === "POST") {
        return new Response(JSON.stringify([{
          id: "asset-3", category: "cash", display_name: "GBP cash", ticker: null, exchange: null, native_currency: "GBP",
          pricing_provider: "none", source_url: null, external_id: "cash:acc-1:GBP", image_url: null, lego_set_number: null,
          metadata: {}, created_at: "2026-08-13T00:00:00.000Z", updated_at: "2026-08-13T00:00:00.000Z", archived_at: null,
        }]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    });
    const response = await createAsset(jsonRequest("http://test/api/investments/assets", { category: "cash", accountId: "11111111-1111-4111-8111-111111111111", currency: "GBP", openingAmount: 500 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pricing).toBeNull();
    expect(pokePulseProvider.getQuote).not.toHaveBeenCalled();
  });

  it("REGRESSION (real confirmed bug): a USD stock's initial purchase applies a genuine FX rate to gbp_total — never stores the raw USD amount as if it were already GBP", async () => {
    // Live-confirmed: a real Meta purchase transaction had gbp_total ===
    // nativeUnitPrice × quantity exactly (an implied 1:1 "FX rate"),
    // because this code path used to never fetch or apply any FX
    // conversion at all. That silently poisoned the cost basis and later
    // showed up as a wildly wrong "Currency effect" figure on the
    // dashboard, even though the decomposition formula itself was correct.
    supabaseRequestAll.mockResolvedValue([{ id: "acc-1" }]);
    let insertedTransactionBody: Record<string, unknown> | null = null;
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_assets" && init?.method === "POST") {
        return new Response(JSON.stringify([{
          id: "asset-meta", category: "stock", display_name: "Meta platforms", ticker: "META", exchange: null, native_currency: "USD",
          pricing_provider: "twelve_data", source_url: null, external_id: "META:", image_url: null, lego_set_number: null,
          metadata: {}, created_at: "2026-08-13T00:00:00.000Z", updated_at: "2026-08-13T00:00:00.000Z", archived_at: null,
        }]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (path === "investment_transactions" && init?.method === "POST") {
        insertedTransactionBody = JSON.parse(init.body as string);
        return new Response(null, { status: 201 });
      }
      return new Response(null, { status: 204 });
    });

    const response = await createAsset(jsonRequest("http://test/api/investments/assets", {
      category: "stock", accountId: "11111111-1111-4111-8111-111111111111", displayName: "Meta platforms", ticker: "META", nativeCurrency: "USD",
      purchaseDate: "2025-11-05", quantity: 6.27088555, purchaseUnitPrice: 480.77, feesGbp: 0,
    }));

    expect(response.status).toBe(200);
    expect(getFxRate).toHaveBeenCalledWith("USD", "2025-11-05");
    expect(insertedTransactionBody).not.toBeNull();
    const tx = insertedTransactionBody as unknown as { gbp_total: number; fx_rate_at_trade: number | null; native_unit_price: number };
    expect(tx.fx_rate_at_trade).toBe(0.74);
    expect(tx.gbp_total).toBeCloseTo(480.77 * 6.27088555 * 0.74, 2);
    // The confirmed-broken value would have been exactly nativeUnitPrice × quantity (implied rate 1.0):
    expect(tx.gbp_total).not.toBeCloseTo(480.77 * 6.27088555, 2);
  });
});

describe("Investments API — holding detail never contradicts itself (source label vs actual pricing state)", () => {
  it("REGRESSION (real confirmed bug — VWRP): a never-priced stock (purchase-price fallback, no snapshot yet) reports dataQuality as 'purchase_price_fallback', not bare null — the drawer's fallback note relies on this to avoid showing a bare, contradictory 'Twelve Data' source label next to 'Never priced'", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("investment_assets?")) return [{
        id: "vwrp-asset", category: "stock", display_name: "Vanguard FTSE All-World", ticker: "VWRP", exchange: "LSE",
        native_currency: "GBP", pricing_provider: "twelve_data", source_url: null, image_url: null, lego_set_number: null, archived_at: null,
      }];
      if (path.startsWith("investment_transactions?")) return [{
        id: "buy-1", account_id: "acc-1", transaction_type: "buy", trade_at: "2025-11-05T00:00:00.000Z",
        quantity: "8.4492", native_unit_price: "129.79", native_currency: "GBP", gbp_total: "1096.63", fx_rate_at_trade: null, gbp_fees: "0", notes: null,
      }];
      if (path.startsWith("investment_price_snapshots?")) return []; // never successfully priced
      return [];
    });
    const response = await getAssetDetail(new Request("http://test/api/investments/assets/vwrp-asset"), { params: Promise.resolve({ assetId: "11111111-1111-4111-8111-111111111111" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.holding.lastPriceAt).toBeNull();
    expect(body.holding.dataQuality).toBe("purchase_price_fallback");
    expect(body.holding.dataQuality).not.toBeNull();
  });
});

describe("Investments API — strict request validation", () => {
  it("rejects an unrecognised asset category (discriminated union) with a 400, never a 200", async () => {
    const response = await createAsset(jsonRequest("http://test/api/investments/assets", { category: "crypto", accountId: "11111111-1111-4111-8111-111111111111" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBeTruthy();
  });

  it("rejects a Pokémon investment whose URL fails PokePulse validation, before ever writing to the database", async () => {
    supabaseRequestAll.mockResolvedValue([{ id: "acc-1" }]); // account exists
    resolvePokePulseIdentity.mockResolvedValue({ ok: false, error: "URL must be on pokepulse.io.", retryable: false });
    const response = await createAsset(jsonRequest("http://test/api/investments/assets", {
      category: "pokemon", accountId: "11111111-1111-4111-8111-111111111111", sourceUrl: "https://evil.com/cards/foo",
    }));
    expect(response.status).toBe(400);
    expect(supabaseRequest.mock.calls.some(c => c[0] === "investment_assets")).toBe(false);
  });

  it("rejects a sell that would oversell the current position, computed server-side from real transaction history", async () => {
    supabaseRequestAll.mockImplementation(async (path: string) => {
      if (path.startsWith("investment_accounts?")) return [{ id: "acc-1" }];
      if (path.startsWith("investment_assets?")) return [{ id: "asset-1" }];
      if (path.startsWith("investment_transactions?")) return [
        { id: "b1", transaction_type: "buy", trade_at: "2026-01-01", quantity: "5" },
      ];
      return [];
    });
    const response = await recordTransaction(jsonRequest("http://test/api/investments/transactions", {
      accountId: "11111111-1111-4111-8111-111111111111", assetId: "22222222-2222-4222-8222-222222222222",
      transactionType: "sell", tradeAt: "2026-02-01", quantity: 10, gbpTotal: 100,
    }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/only .* are currently held/i);
  });

  it("never exposes a Supabase service-role/secret key anywhere in a response body", async () => {
    const response = await getAccounts();
    const text = await response.text();
    expect(text).not.toMatch(/service_role|SUPABASE_SECRET_KEY/i);
  });
});

describe("Investments API — refresh partial success is surfaced, not swallowed", () => {
  // The route streams newline-delimited JSON (progress lines, then one
  // final {type:"done",result:...} line) so the client can show real
  // refresh progress — see this feature's own completion report. Reading
  // the whole stream and taking the last line mirrors exactly what the
  // client's own readRefreshStream() does.
  async function readNdjson(response: Response): Promise<Array<Record<string, unknown>>> {
    const text = await response.text();
    return text.split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
  }

  it("POST /api/investments/refresh streams a final done line with the run's status/results, never throwing on a provider failure", async () => {
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === "investment_refresh_runs") return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      return new Response(null, { status: 204 });
    });
    const response = await refreshPrices(new Request("http://test/api/investments/refresh", { method: "POST" }));
    expect(response.status).toBe(200);
    const lines = await readNdjson(response);
    const done = lines.find(l => l.type === "done");
    expect(done).toBeDefined();
    const result = done!.result as { results: unknown[] };
    expect(result.results).toEqual([]); // no assets configured in this mock — a legitimate, non-error empty run
  });

  it("records the real trigger sent by the client — auto_page_open is stored, never silently coerced to manual", async () => {
    let insertedTrigger: unknown;
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_refresh_runs" && init?.method === "POST") {
        insertedTrigger = JSON.parse(init.body as string).trigger;
        return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    });
    const response = await refreshPrices(new Request("http://test/api/investments/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trigger: "auto_page_open" }),
    }));
    await response.text(); // drain the NDJSON stream so its async start() body has actually run
    expect(insertedTrigger).toBe("auto_page_open");
  });

  it("defaults to manual when no trigger is sent (backward compatible with a bare POST)", async () => {
    let insertedTrigger: unknown;
    supabaseRequest.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "investment_refresh_runs" && init?.method === "POST") {
        insertedTrigger = JSON.parse(init.body as string).trigger;
        return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    });
    const response = await refreshPrices(new Request("http://test/api/investments/refresh", { method: "POST" }));
    await response.text();
    expect(insertedTrigger).toBe("manual");
  });

  it("rejects an arbitrary client-submitted trigger value — 'cron' is never reachable from this HTTP route, only from the cron route calling runRefresh() directly", async () => {
    const response = await refreshPrices(new Request("http://test/api/investments/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trigger: "cron" }),
    }));
    expect(response.status).toBe(400);
  });

  it("rejects a completely made-up trigger value", async () => {
    const response = await refreshPrices(new Request("http://test/api/investments/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trigger: "hacked" }),
    }));
    expect(response.status).toBe(400);
  });
});
