import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("PHASE 3 — GET /api/cron/ebay-draft-processing is RETIRED (a no-op sweep)", () => {
  beforeEach(() => { delete process.env.CRON_SECRET; });

  it("requires the CRON_SECRET bearer auth exactly like every other cron route — never a silent 200 to an unauthenticated caller", async () => {
    const { GET } = await import("@/app/api/cron/ebay-draft-processing/route");
    const response = await GET(new Request("http://test"));
    expect(response.status).toBe(401);
  });

  it("with a valid secret, returns retired:true and performs no work — no Supabase call, no eBay call, no import of the legacy processing pipeline", async () => {
    process.env.CRON_SECRET = "test-secret";
    const source = require("node:fs").readFileSync("app/api/cron/ebay-draft-processing/route.ts", "utf8") as string;
    expect(source).not.toMatch(/from ["']@\/lib\/listing-studio\/ebay-draft-batches["']/);
    expect(source).not.toMatch(/from ["']@\/lib\/supabase["']/);
    const { GET } = await import("@/app/api/cron/ebay-draft-processing/route");
    const response = await GET(new Request("http://test", { headers: { authorization: "Bearer test-secret" } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.retired).toBe(true);
  });
});

const { supabaseRequest, supabaseRequestAll, runEbayFeedBatchProcessTick } = vi.hoisted(() => ({
  supabaseRequest: vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify([]), { status: 200 })),
  supabaseRequestAll: vi.fn(async (_path: string) => [] as unknown[]),
  runEbayFeedBatchProcessTick: vi.fn(async (_ownerId: string, _batchId: string) => ({ claimedCount: 0, batchStatus: null as string | null, hasMoreWork: false })),
}));
vi.mock("@/lib/supabase", () => ({ supabaseRequest, supabaseRequestAll }));
vi.mock("@/lib/listing-studio/ebay-feed/feed-batches", () => ({ runEbayFeedBatchProcessTick }));

describe("GET /api/cron/ebay-feed-processing — the active Seller Hub draft pipeline's own sweep", () => {
  beforeEach(() => {
    delete process.env.CRON_SECRET;
    supabaseRequest.mockReset(); supabaseRequestAll.mockReset(); runEbayFeedBatchProcessTick.mockReset();
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    supabaseRequestAll.mockResolvedValue([]);
    runEbayFeedBatchProcessTick.mockResolvedValue({ claimedCount: 0, batchStatus: null, hasMoreWork: false });
  });

  it("requires the CRON_SECRET bearer auth", async () => {
    const { GET } = await import("@/app/api/cron/ebay-feed-processing/route");
    const response = await GET(new Request("http://test"));
    expect(response.status).toBe(401);
  });

  it("with no claimable work, skips cleanly", async () => {
    process.env.CRON_SECRET = "test-secret";
    supabaseRequest.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const { GET } = await import("@/app/api/cron/ebay-feed-processing/route");
    const response = await GET(new Request("http://test", { headers: { authorization: "Bearer test-secret" } }));
    const body = await response.json();
    expect(body.skipped).toBe("no_claimable_work");
    expect(runEbayFeedBatchProcessTick).not.toHaveBeenCalled();
  });

  it("ticks exactly once per claimable batch, across every owner with claimable work", async () => {
    process.env.CRON_SECRET = "test-secret";
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === "rpc/listing_studio_owners_with_claimable_ebay_feed_work") return new Response(JSON.stringify([{ owner_id: "owner-1" }]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    supabaseRequestAll.mockResolvedValue([{ id: "batch-1", owner_id: "owner-1" }, { id: "batch-2", owner_id: "owner-1" }]);
    const { GET } = await import("@/app/api/cron/ebay-feed-processing/route");
    const response = await GET(new Request("http://test", { headers: { authorization: "Bearer test-secret" } }));
    const body = await response.json();
    expect(body.ownersProcessed).toBe(1);
    expect(body.batchesTicked).toBe(2);
    expect(runEbayFeedBatchProcessTick).toHaveBeenCalledWith("owner-1", "batch-1");
    expect(runEbayFeedBatchProcessTick).toHaveBeenCalledWith("owner-1", "batch-2");
  });

  it("one batch's tick failure never blocks the others in the same sweep", async () => {
    process.env.CRON_SECRET = "test-secret";
    supabaseRequest.mockImplementation(async (path: string) => {
      if (path === "rpc/listing_studio_owners_with_claimable_ebay_feed_work") return new Response(JSON.stringify([{ owner_id: "owner-1" }]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    supabaseRequestAll.mockResolvedValue([{ id: "batch-1", owner_id: "owner-1" }, { id: "batch-2", owner_id: "owner-1" }]);
    runEbayFeedBatchProcessTick.mockImplementation(async (_ownerId: string, batchId: string) => {
      if (batchId === "batch-1") throw new Error("boom");
      return { claimedCount: 1, batchStatus: "processing", hasMoreWork: true };
    });
    const { GET } = await import("@/app/api/cron/ebay-feed-processing/route");
    const response = await GET(new Request("http://test", { headers: { authorization: "Bearer test-secret" } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.batchesTicked).toBe(2);
  });
});

describe("vercel.json — cron schedule is deployable on Vercel Hobby (at most once per day)", () => {
  it("no cron entry fires more than once per 24 hours", () => {
    const config = JSON.parse(require("node:fs").readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    for (const cron of config.crons) {
      const fields = cron.schedule.trim().split(/\s+/);
      expect(fields, cron.path).toHaveLength(5);
      const [minute, hour] = fields;
      // A schedule fires more than once/day if either minute or hour field
      // contains a wildcard/step/list rather than one fixed value — a
      // rough but effective check matching Vercel's own documented Hobby
      // constraint (fetched this session: "Hobby: Once per day... any
      // expression that would fire more than once a day fails at deploy
      // time").
      expect(/^\d+$/.test(minute), `${cron.path} minute field "${minute}" must be a single fixed value`).toBe(true);
      expect(/^\d+$/.test(hour), `${cron.path} hour field "${hour}" must be a single fixed value`).toBe(true);
    }
  });

  it("the eBay Feed processing sweep is registered, pointing at the new (not legacy) route", () => {
    const config = JSON.parse(require("node:fs").readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const paths = config.crons.map(c => c.path);
    expect(paths).toContain("/api/cron/ebay-feed-processing");
    expect(paths).not.toContain("/api/cron/ebay-draft-processing");
  });
});
