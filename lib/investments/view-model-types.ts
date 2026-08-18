/** Client-side mirror of app/api/investments/portfolio/route.ts's JSON response shape. */

export type PortfolioTotalsResponse = {
  totalGbpValue: number; totalInvestedGbp: number; allTimeReturnGbp: number; allTimeReturnPercent: number | null;
  marketGrowthGbp: number; currencyEffectGbp: number; cashGbp: number;
  todaysChangeGbp: number; todaysChangePercent: number | null;
};

export type BestPerformerResponse = { assetId: string; displayName: string; ticker: string | null; percent: number } | null;

export type AllocationResponse = { category: string; gbpValue: number; percent: number };

export type HoldingResponse = {
  assetId: string; category: string; displayName: string; ticker: string | null;
  quantity: string; costBasisGbp: number; currentGbpValue: number; unrealizedGbp: number; unrealizedPercent: number | null;
  allocationPercent: number; nativeCurrency: string; pricingProvider: string; imageUrl: string | null; sourceUrl: string | null;
  currentNativePrice: number | null; priceAt: string | null; dataQuality: string | null; sparkline: number[];
};

export type AccountResponse = { id: string; name: string; accountType: string; gbpValue: number; returnGbp: number; returnPercent: number | null; lastSyncedAt: string | null; allLive: boolean; hasPriceableAssets: boolean };

export type ChartPointResponse = { date: string; totalGbpValue: number; dataQuality: "market" | "mixed" | "purchase_price_fallback" };

export type CashFlowEventResponse = { date: string; amountGbp: number; label: string; count: number };

export type PortfolioViewModel = {
  totals: PortfolioTotalsResponse;
  bestPerformer: BestPerformerResponse;
  allocation: AllocationResponse[];
  holdings: HoldingResponse[];
  accounts: AccountResponse[];
  chartSeries: ChartPointResponse[];
  cashFlowEvents: CashFlowEventResponse[];
  fallbackHoldingsCount: number;
};
