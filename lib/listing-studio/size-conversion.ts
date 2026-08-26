/**
 * Milestone 4 sizing correction, then two sizing coverage corrections. The
 * AI never converts a size itself (see listing-generation-schemas.ts's own
 * comment) — it only ever reports exactly what's printed on the label:
 * which system (UK/EU/US), which value, and (only if the label itself
 * states it) which category (mens/womens/unisex/childrens). This file is
 * the ONE place that deterministic EU/US -> UK conversion happens.
 *
 * RESEARCH METHODOLOGY: per explicit instruction, no table below is
 * reconstructed from memory. Every table is built from that brand's own
 * official site (or, for the generic fallback, a small number of named,
 * reputable general size-guide sources), access date recorded per table.
 * Verified against an official source (as of 2026-08-03): Nike, New
 * Balance, Timberland, Dr Martens, Crocs, Merrell, Clarks, Adidas, ASICS,
 * Salomon, Birkenstock. See EXCLUDED_BRANDS_NO_OFFICIAL_DATA below for
 * brands where no verified official data could be obtained after two
 * research passes, and why.
 *
 * NO ARBITRARY COLLISION RESOLUTION (2026-08-03 correction): an earlier
 * version of this file resolved same-source-value collisions (e.g. two
 * different UK sizes both officially published as "EU 40") by picking
 * whichever UK size was higher. That was an arbitrary guess disguised as a
 * table-construction detail, and it's been removed entirely. Every table
 * below is built by buildExactUkReverseMap() from each brand's raw
 * published rows: if the exact same EU (or US) value is genuinely
 * published against more than one UK size, that value is EXCLUDED from
 * the table — never resolved by picking higher, lower, or "the more
 * common" one. A brand publishing size as a range (e.g. "EU 40-41") is
 * treated as that row making two candidate claims (40 and 41), each
 * subject to the same collision rule. The result is that some brands'
 * generic-fallback and range-published tables are sparser than before —
 * this is the correct behaviour, not a regression: an ambiguous size
 * belongs blank for manual entry, not guessed.
 *
 * CHILDRENS TABLES — general policy: a brand's official kids/childrens
 * chart is very often split into age sub-brackets (infant/toddler/junior,
 * or "little kid"/"big kid") whose raw UK numbers overlap — e.g. Dr
 * Martens' Toddler UK3 is EU19, but Junior's UK3 (after the standard
 * UK-kids-to-adult numbering reset) is EU36. Since sourceSize.gender only
 * has one "childrens" bucket (no sub-bracket), a brand table is only
 * included below when its published UK numbers are genuinely
 * non-overlapping end to end; otherwise childrens conversion for that
 * brand falls through to the generic fallback, exactly like an
 * unsupported brand would. Confirmed clean: Merrell only.
 */

export type SizeCategory = "mens" | "womens" | "unisex" | "childrens";
export type ConvertibleSizeSystem = "EU" | "US";
export type SourceSizeSystem = "UK" | ConvertibleSizeSystem;
export type UkSizeProvenance = "observed" | "brand_converted" | "fallback_converted";

export type SizeConversionResult = {
  ukSize: string | null;
  provenance: UkSizeProvenance | null;
};

type SizeConversionMap = Record<string, string>;
// A brand's table for one system (EU or US). Most brands modelled below
// don't publish a genuinely distinct "unisex" chart — an explicit "unisex"
// request then uses `mens` (see resolveBrandCategoryMap), the conventional
// read of "unisex" for athletic/outdoor footwear absent a brand saying
// otherwise. `unisex` itself is reserved for a brand whose OWN official
// chart states a system is gender-invariant (e.g. Adidas' EU column,
// which is one number regardless of gender even though its US column
// prints a different label for men's vs women's of the same physical
// shoe) — never inferred, only used when the source explicitly says so.
type BrandGenderSizeMap = Partial<Record<"mens" | "womens" | "unisex" | "childrens", SizeConversionMap>>;
type BrandSizeConversionTable = Partial<Record<ConvertibleSizeSystem, BrandGenderSizeMap>>;

// ---------------------------------------------------------------------------
// TABLE-CONSTRUCTION ENGINE — the one place ambiguity is decided, so it's
// auditable/testable in one spot rather than re-derived by hand per brand.
//
// Each row is that brand's own published UK size plus its own published
// EU/US reading(s) for that UK size. A reading is either a single value, or
// (for a brand that itself only publishes a size as a range, e.g. "40-41")
// an array of the range's distinct values — never anything computed or
// guessed by this codebase. buildExactUkReverseMap then inverts every row
// into a value -> UK claim, and keeps a value in the final table ONLY when
// exactly one UK size claims it across the WHOLE table. A value claimed by
// two or more distinct UK sizes is dropped entirely — not resolved by
// picking either one.
type SizeSourceRow = { uk: string; eu?: string | string[]; us?: string | string[] };

function candidateValues(reading: string | string[] | undefined): string[] {
  if (reading === undefined) return [];
  return Array.isArray(reading) ? reading : [reading];
}

function buildExactUkReverseMap(rows: SizeSourceRow[], system: "eu" | "us"): SizeConversionMap {
  const claimants = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const value of candidateValues(row[system])) {
      if (!claimants.has(value)) claimants.set(value, new Set());
      claimants.get(value)!.add(row.uk);
    }
  }
  const table: SizeConversionMap = {};
  for (const [value, ukSizes] of claimants) {
    if (ukSizes.size === 1) table[value] = [...ukSizes][0];
  }
  return table;
}

// ---------------------------------------------------------------------------
// GENERIC FALLBACK TABLE
//
// Sources (accessed 2026-07-30):
//   - Adult mens/unisex + adult womens: Foot Locker UK size guide
//     (footlocker.co.uk size-guide).
//   - Childrens: kiwisizing.com UK/EU/US childrens shoe-size chart.
//
// Foot Locker's own chart gives EU as a range for every whole UK size
// (e.g. UK7 = "40-41") — real published behaviour (EU sizing is coarser
// than UK/US half sizes), not a transcription artefact. Each such range is
// modelled as two candidate EU values per buildExactUkReverseMap above;
// since adjacent UK rows' ranges/singles overlap almost everywhere in this
// particular chart, most EU values turn out genuinely ambiguous and are
// correctly excluded — the resulting EU fallback tables are intentionally
// sparse. The US column has no ranges at all and converts fully.
const FALLBACK_MENS_UNISEX_ROWS: SizeSourceRow[] = [
  { uk: "5", eu: "38", us: "5.5" },
  { uk: "5.5", eu: "39", us: "6" },
  { uk: "6", eu: "39", us: "6.5" },
  { uk: "6.5", eu: "40", us: "7" },
  { uk: "7", eu: ["40", "41"], us: "7.5" },
  { uk: "7.5", eu: "41", us: "8" },
  { uk: "8", eu: ["41", "42"], us: "8.5" },
  { uk: "8.5", eu: "42", us: "9" },
  { uk: "9", eu: ["42", "43"], us: "9.5" },
  { uk: "9.5", eu: "43", us: "10" },
  { uk: "10", eu: ["43", "44"], us: "10.5" },
  { uk: "10.5", eu: "44", us: "11" },
  { uk: "11", eu: ["44", "45"], us: "11.5" },
  { uk: "11.5", eu: "45", us: "12" },
  { uk: "12", eu: ["45", "46"], us: "12.5" },
  { uk: "12.5", eu: "46", us: "13" },
  { uk: "13", eu: ["46", "47"], us: "13.5" },
  { uk: "13.5", eu: "47", us: "14" },
  { uk: "14", eu: ["47", "48"], us: "14.5" },
  { uk: "14.5", eu: "48", us: "15" },
  { uk: "15", eu: ["48", "49"], us: "15.5" },
  { uk: "15.5", eu: "49", us: "16" },
];
const FALLBACK_WOMENS_ROWS: SizeSourceRow[] = [
  { uk: "2", eu: "35", us: "4" },
  { uk: "2.5", eu: "35", us: "4.5" },
  { uk: "3", eu: ["35", "36"], us: "5" },
  { uk: "3.5", eu: "36", us: "5.5" },
  { uk: "4", eu: ["36", "37"], us: "6" },
  { uk: "4.5", eu: "37", us: "6.5" },
  { uk: "5", eu: ["37", "38"], us: "7" },
  { uk: "5.5", eu: "38", us: "7.5" },
  { uk: "6", eu: ["38", "39"], us: "8" },
  { uk: "6.5", eu: "39", us: "8.5" },
  { uk: "7", eu: ["39", "40"], us: "9" },
  { uk: "7.5", eu: "40", us: "9.5" },
  { uk: "8", eu: ["40", "41"], us: "10" },
  { uk: "8.5", eu: "41", us: "10.5" },
  { uk: "9", eu: ["41", "42"], us: "11" },
  { uk: "9.5", eu: "42", us: "11.5" },
  { uk: "10", eu: ["42", "43"], us: "12" },
  { uk: "10.5", eu: "43", us: "12.5" },
  { uk: "11", eu: ["43", "44"], us: "13" },
  { uk: "11.5", eu: "44", us: "13.5" },
  { uk: "12", eu: ["44", "45"], us: "14" },
];
// UK13/EU32/US1 dropped entirely — kiwisizing's own chart marks this as
// the transition point into adult numbering, ambiguous with adult UK13
// conventions; not modelled here at all (childrens stops at UK12.5).
const FALLBACK_CHILDRENS_ROWS: SizeSourceRow[] = [
  { uk: "0.5", eu: "16", us: "1" },
  { uk: "1", eu: "17", us: ["1.5", "2"] }, // kiwisizing itself gives both US readings for this one row
  { uk: "1.5", eu: "18", us: "2.5" },
  { uk: "2", eu: "18", us: "3" },
  { uk: "2.5", eu: "19", us: "3.5" },
  { uk: "3", eu: "19", us: "4" },
  { uk: "3.5", eu: "20", us: "4.5" },
  { uk: "4", eu: "20", us: "5" },
  { uk: "4.5", eu: "21", us: "5.5" },
  { uk: "5", eu: "22", us: "6" },
  { uk: "5.5", eu: "22", us: "6.5" },
  { uk: "6", eu: "23", us: "7" },
  { uk: "6.5", eu: "23", us: "7.5" },
  { uk: "7", eu: "24", us: "8" },
  { uk: "7.5", eu: "25", us: "8.5" },
  { uk: "8", eu: "25.5", us: "9" },
  { uk: "8.5", eu: "26", us: "9.5" },
  { uk: "9", eu: "27", us: "10" },
  { uk: "9.5", eu: "27", us: "10.5" },
  { uk: "10", eu: "28", us: "11" },
  { uk: "10.5", eu: "29", us: "11.5" },
  { uk: "11", eu: "30", us: "12" },
  { uk: "11.5", eu: "30", us: "12.5" },
  { uk: "12", eu: "31", us: "13" },
  { uk: "12.5", eu: "31", us: "13.5" },
];

const GENERIC_FALLBACK_TABLE: Record<ConvertibleSizeSystem, {
  mensUnisex: SizeConversionMap;
  womens: SizeConversionMap;
  childrens: SizeConversionMap;
}> = {
  EU: {
    mensUnisex: buildExactUkReverseMap(FALLBACK_MENS_UNISEX_ROWS, "eu"),
    womens: buildExactUkReverseMap(FALLBACK_WOMENS_ROWS, "eu"),
    childrens: buildExactUkReverseMap(FALLBACK_CHILDRENS_ROWS, "eu"),
  },
  US: {
    mensUnisex: buildExactUkReverseMap(FALLBACK_MENS_UNISEX_ROWS, "us"),
    womens: buildExactUkReverseMap(FALLBACK_WOMENS_ROWS, "us"),
    childrens: buildExactUkReverseMap(FALLBACK_CHILDRENS_ROWS, "us"),
  },
};

// ---------------------------------------------------------------------------
// BRAND-SPECIFIC TABLES

// Nike: https://www.nike.com/size-fit/mens-footwear and
// https://www.nike.com/size-fit/womens-footwear, accessed 2026-07-30. Nike's
// own chart has two genuine irregularities preserved as published: UK6
// appears for both US6.5 (EU39) and US7 (EU40) — both real, distinct EU
// values, so no collision (EU39 and EU40 each still have exactly one
// claimant, UK6). No US/EU table gap; category coverage: mens, womens.
const NIKE_MENS_ROWS: SizeSourceRow[] = [
  { uk: "3", eu: "35.5", us: "3.5" },
  { uk: "3.5", eu: "36", us: "4" },
  { uk: "4", eu: "36.5", us: "4.5" },
  { uk: "4.5", eu: "37.5", us: "5" },
  { uk: "5", eu: "38", us: "5.5" },
  { uk: "5.5", eu: "38.5", us: "6" },
  { uk: "6", eu: "39", us: "6.5" },
  { uk: "6", eu: "40", us: "7" },
  { uk: "6.5", eu: "40.5", us: "7.5" },
  { uk: "7", eu: "41", us: "8" },
  { uk: "7.5", eu: "42", us: "8.5" },
  { uk: "8", eu: "42.5", us: "9" },
  { uk: "8.5", eu: "43", us: "9.5" },
  { uk: "9", eu: "44", us: "10" },
  { uk: "9.5", eu: "44.5", us: "10.5" },
  { uk: "10", eu: "45", us: "11" },
  { uk: "10.5", eu: "45.5", us: "11.5" },
  { uk: "11", eu: "46", us: "12" },
  { uk: "11.5", eu: "47", us: "12.5" },
  { uk: "12", eu: "47.5", us: "13" },
  { uk: "12.5", eu: "48", us: "13.5" },
  { uk: "13", eu: "48.5", us: "14" },
];
const NIKE_WOMENS_ROWS: SizeSourceRow[] = [
  { uk: "1.5", eu: "33.5", us: "3.5" },
  { uk: "1.5", eu: "34.5", us: "4" },
  { uk: "2", eu: "35", us: "4.5" },
  { uk: "2.5", eu: "35.5", us: "5" },
  { uk: "3", eu: "36", us: "5.5" },
  { uk: "3.5", eu: "36.5", us: "6" },
  { uk: "4", eu: "37.5", us: "6.5" },
  { uk: "4.5", eu: "38", us: "7" },
  { uk: "5", eu: "38.5", us: "7.5" },
  { uk: "5.5", eu: "39", us: "8" },
  { uk: "6", eu: "40", us: "8.5" },
  { uk: "6.5", eu: "40.5", us: "9" },
  { uk: "7", eu: "41", us: "9.5" },
  { uk: "7.5", eu: "42", us: "10" },
  { uk: "8", eu: "42.5", us: "10.5" },
  { uk: "8.5", eu: "43", us: "11" },
  { uk: "9", eu: "44", us: "11.5" },
  { uk: "9.5", eu: "44.5", us: "12" },
  { uk: "10", eu: "45", us: "12.5" },
  { uk: "10.5", eu: "45.5", us: "13" },
  { uk: "11", eu: "46", us: "13.5" },
  { uk: "11.5", eu: "47", us: "14" },
];

// New Balance: official printable PDFs linked from
// newbalance.com/size-guide.html (Mens_Printable_Sizing_Tool.pdf /
// Womens_Printable_Sizing_Tool.pdf), accessed 2026-07-30. No kids chart
// verified (the official kids PDF is a foot-tracing tool with no numeric
// table). Category coverage: mens, womens. Both EU and US.
const NEW_BALANCE_MENS_ROWS: SizeSourceRow[] = [
  { uk: "3.5", eu: "36", us: "4" },
  { uk: "4", eu: "37", us: "4.5" },
  { uk: "4.5", eu: "37.5", us: "5" },
  { uk: "5", eu: "38", us: "5.5" },
  { uk: "5.5", eu: "38.5", us: "6" },
  { uk: "6", eu: "39.5", us: "6.5" },
  { uk: "6.5", eu: "40", us: "7" },
  { uk: "7", eu: "40.5", us: "7.5" },
  { uk: "7.5", eu: "41.5", us: "8" },
  { uk: "8", eu: "42", us: "8.5" },
  { uk: "8.5", eu: "42.5", us: "9" },
  { uk: "9", eu: "43", us: "9.5" },
  { uk: "9.5", eu: "44", us: "10" },
  { uk: "10", eu: "44.5", us: "10.5" },
  { uk: "10.5", eu: "45", us: "11" },
  { uk: "11", eu: "45.5", us: "11.5" },
  { uk: "11.5", eu: "46.5", us: "12" },
  { uk: "12", eu: "47", us: "12.5" },
  { uk: "12.5", eu: "47.5", us: "13" },
  { uk: "13.5", eu: "49", us: "14" },
  { uk: "14.5", eu: "50", us: "15" },
  { uk: "15.5", eu: "51", us: "16" },
  { uk: "16.5", eu: "52", us: "17" },
  { uk: "17.5", eu: "53", us: "18" },
  { uk: "18.5", eu: "54", us: "19" },
  { uk: "19.5", eu: "55", us: "20" },
];
const NEW_BALANCE_WOMENS_ROWS: SizeSourceRow[] = [
  { uk: "2", eu: "34", us: "4" },
  { uk: "2.5", eu: "34.5", us: "4.5" },
  { uk: "3", eu: "35", us: "5" },
  { uk: "3.5", eu: "36", us: "5.5" },
  { uk: "4", eu: "36.5", us: "6" },
  { uk: "4.5", eu: "37", us: "6.5" },
  { uk: "5", eu: "37.5", us: "7" },
  { uk: "5.5", eu: "38", us: "7.5" },
  { uk: "6", eu: "39", us: "8" },
  { uk: "6.5", eu: "40", us: "8.5" },
  { uk: "7", eu: "40.5", us: "9" },
  { uk: "7.5", eu: "41", us: "9.5" },
  { uk: "8", eu: "41.5", us: "10" },
  { uk: "8.5", eu: "42.5", us: "10.5" },
  { uk: "9", eu: "43", us: "11" },
  { uk: "9.5", eu: "43.5", us: "11.5" },
  { uk: "10", eu: "44", us: "12" },
  { uk: "10.5", eu: "45", us: "12.5" },
  { uk: "11", eu: "45.5", us: "13" },
  { uk: "11.5", eu: "46", us: "13.5" },
  { uk: "12", eu: "46.5", us: "14" },
  { uk: "13", eu: "48", us: "15" },
];

// Timberland: timberland.com/en-gb/customer-care/size-chart (Men's,
// Women's), cross-checked identical against the en-us equivalent, accessed
// 2026-07-30. Kids chart is split into 4 overlapping-UK-number age
// sub-brackets — excluded, falls through to generic fallback. Category
// coverage: mens, womens. Both EU and US.
const TIMBERLAND_MENS_ROWS: SizeSourceRow[] = [
  { uk: "3.5", eu: "36", us: "4" },
  { uk: "4", eu: "37", us: "4.5" },
  { uk: "4.5", eu: "37.5", us: "5" },
  { uk: "5", eu: "38", us: "5.5" },
  { uk: "5.5", eu: "39", us: "6" },
  { uk: "6", eu: "39.5", us: "6.5" },
  { uk: "6.5", eu: "40", us: "7" },
  { uk: "7", eu: "41", us: "7.5" },
  { uk: "7.5", eu: "41.5", us: "8" },
  { uk: "8", eu: "42", us: "8.5" },
  { uk: "8.5", eu: "43", us: "9" },
  { uk: "9", eu: "43.5", us: "9.5" },
  { uk: "9.5", eu: "44", us: "10" },
  { uk: "10", eu: "44.5", us: "10.5" },
  { uk: "10.5", eu: "45", us: "11" },
  { uk: "11", eu: "45.5", us: "11.5" },
  { uk: "11.5", eu: "46", us: "12" },
  { uk: "12.5", eu: "47.5", us: "13" },
  { uk: "13.5", eu: "49", us: "14" },
  { uk: "14.5", eu: "50", us: "15" },
];
const TIMBERLAND_WOMENS_ROWS: SizeSourceRow[] = [
  { uk: "3", eu: "35.5", us: "5" },
  { uk: "3.5", eu: "36", us: "5.5" },
  { uk: "4", eu: "37", us: "6" },
  { uk: "4.5", eu: "37.5", us: "6.5" },
  { uk: "5", eu: "38", us: "7" },
  { uk: "5.5", eu: "38.5", us: "7.5" },
  { uk: "6", eu: "39", us: "8" },
  { uk: "6.5", eu: "39.5", us: "8.5" },
  { uk: "7", eu: "40", us: "9" },
  { uk: "7.5", eu: "41", us: "9.5" },
  { uk: "8", eu: "41.5", us: "10" },
  { uk: "9", eu: "42", us: "11" },
];

// Dr Martens: drmartens.com/uk/en_gb/shoe-size-guide, cross-checked against
// the en-us and eu regional pages, accessed 2026-07-30. Men's UK14/UK15
// use the UK+US pages' EU49/EU50 (2-of-3 official pages agree; the EU
// regional page alone says 49.5/50.5 at those two sizes — flagged, not
// resolved). Kids chart (Toddler/Junior) overlaps — excluded, falls
// through to generic fallback. Category coverage: mens, womens. Both EU
// and US.
const DR_MARTENS_MENS_ROWS: SizeSourceRow[] = [
  { uk: "6", eu: "39", us: "7" },
  { uk: "6.5", eu: "40", us: "7.5" },
  { uk: "7", eu: "41", us: "8" },
  { uk: "8", eu: "42", us: "9" },
  { uk: "9", eu: "43", us: "10" },
  { uk: "9.5", eu: "44", us: "10.5" },
  { uk: "10", eu: "45", us: "11" },
  { uk: "11", eu: "46", us: "12" },
  { uk: "12", eu: "47", us: "13" },
  { uk: "13", eu: "48", us: "14" },
  { uk: "14", eu: "49", us: "15" },
  { uk: "15", eu: "50", us: "16" },
];
const DR_MARTENS_WOMENS_ROWS: SizeSourceRow[] = [
  { uk: "3", eu: "36", us: "5" },
  { uk: "4", eu: "37", us: "6" },
  { uk: "5", eu: "38", us: "7" },
  { uk: "6", eu: "39", us: "8" },
  { uk: "6.5", eu: "40", us: "8.5" },
  { uk: "7", eu: "41", us: "9" },
  { uk: "8", eu: "42", us: "10" },
  { uk: "9", eu: "43", us: "11" },
];

// Salomon: salomon.com/en-us/sizingchart, accessed 2026-08-03. The
// flagship page blocks a normal fetch, but the same URL's own
// server-rendered Next.js data payload (fetched through a network-only
// CORS relay — Salomon's own HTTP response, no third-party data) embeds
// Salomon's Contentful CMS entries for this exact page, including
// separate "footwear-men" and "footwear-women" tables (values kept
// exactly as published, including EU thirds like "40 2/3"). Salomon also
// publishes an internally-inconsistent "unisex" combined table (same
// pattern as Crocs/ASICS) — the standalone Men's/Women's tables are used
// here instead. No kids table sourced (Salomon's own bonus kids/generic
// chart has irregular gaps and mixes kids/adult numbering ambiguously).
// Category coverage: mens, womens. Both EU and US.
const SALOMON_MENS_ROWS: SizeSourceRow[] = [
  { uk: "6.5", eu: "40", us: "7" },
  { uk: "7", eu: "40 2/3", us: "7.5" },
  { uk: "7.5", eu: "41 1/3", us: "8" },
  { uk: "8", eu: "42", us: "8.5" },
  { uk: "8.5", eu: "42 2/3", us: "9" },
  { uk: "9", eu: "43 1/3", us: "9.5" },
  { uk: "9.5", eu: "44", us: "10" },
  { uk: "10", eu: "44 2/3", us: "10.5" },
  { uk: "10.5", eu: "45 1/3", us: "11" },
  { uk: "11", eu: "46", us: "11.5" },
  { uk: "11.5", eu: "46 2/3", us: "12" },
  { uk: "12", eu: "47 1/3", us: "12.5" },
  { uk: "12.5", eu: "48", us: "13" },
  { uk: "13", eu: "48 2/3", us: "13.5" },
  { uk: "13.5", eu: "49 1/3", us: "14" },
];
const SALOMON_WOMENS_ROWS: SizeSourceRow[] = [
  { uk: "3.5", eu: "36", us: "5" },
  { uk: "4", eu: "36 2/3", us: "5.5" },
  { uk: "4.5", eu: "37 1/3", us: "6" },
  { uk: "5", eu: "38", us: "6.5" },
  { uk: "5.5", eu: "38 2/3", us: "7" },
  { uk: "6", eu: "39 1/3", us: "7.5" },
  { uk: "6.5", eu: "40", us: "8" },
  { uk: "7", eu: "40 2/3", us: "8.5" },
  { uk: "7.5", eu: "41 1/3", us: "9" },
  { uk: "8", eu: "42", us: "9.5" },
  { uk: "8.5", eu: "42 2/3", us: "10" },
  { uk: "9", eu: "43 1/3", us: "10.5" },
  { uk: "9.5", eu: "44", us: "11" },
  { uk: "10", eu: "44 2/3", us: "11.5" },
  { uk: "10.5", eu: "45 1/3", us: "12" },
  { uk: "11", eu: "46", us: "12.5" },
  { uk: "11.5", eu: "46 2/3", us: "13" },
  { uk: "12", eu: "47 1/3", us: "13.5" },
  { uk: "12.5", eu: "48", us: "14" },
  { uk: "13", eu: "48 2/3", us: "14.5" },
  { uk: "13.5", eu: "49 1/3", us: "15" },
  { uk: "14", eu: "50", us: "15.5" },
  { uk: "14.5", eu: "50 2/3", us: "16" },
];

// Birkenstock: birkenstock.com — the UK-locale page (UK + foot-length-mm)
// and every EU-locale page (EU + the SAME foot-length-mm bins, byte-for-
// byte identical across gb/hr-en/de-en/on.demandware.store) share an
// explicit, non-inferred key: identical mm bins. This was independently
// confirmed by a real product's own Product-Variation API response, whose
// `sizeMap` gives literal "UK;EU" pairs (e.g. "7;40") straight from
// Birkenstock's own commerce backend — no join/inference needed at all.
// Accessed 2026-08-03. UK/EU is gender-invariant (one EU number per
// physical shoe size, like Adidas) — modelled with a `unisex` EU table;
// the US label is published only as a half-size range (e.g. "9–9½") and
// differs by gender, modelled as two candidate US values per row. A kids
// chart (its own non-overlapping UK range, confirmed via the same
// Product-Variation pattern on a kids product) is included as childrens.
// Category coverage: mens, womens (US only) + unisex (EU) + childrens
// (both). Both EU and US.
const BIRKENSTOCK_ADULT_EU_ROWS: SizeSourceRow[] = [
  { uk: "2.5", eu: "35" },
  { uk: "3.5", eu: "36" },
  { uk: "4.5", eu: "37" },
  { uk: "5", eu: "38" },
  { uk: "5.5", eu: "39" },
  { uk: "7", eu: "40" },
  { uk: "7.5", eu: "41" },
  { uk: "8", eu: "42" },
  { uk: "9", eu: "43" },
  { uk: "9.5", eu: "44" },
  { uk: "10.5", eu: "45" },
  { uk: "11.5", eu: "46" },
  { uk: "12", eu: "47" },
  { uk: "13", eu: "48" },
  { uk: "14", eu: "49" },
  { uk: "14.5", eu: "50" },
];
const BIRKENSTOCK_ADULT_WOMENS_US_ROWS: SizeSourceRow[] = [
  { uk: "2.5", us: ["4", "4.5"] },
  { uk: "3.5", us: ["5", "5.5"] },
  { uk: "4.5", us: ["6", "6.5"] },
  { uk: "5", us: ["7", "7.5"] },
  { uk: "5.5", us: ["8", "8.5"] },
  { uk: "7", us: ["9", "9.5"] },
  { uk: "7.5", us: ["10", "10.5"] },
  { uk: "8", us: ["11", "11.5"] },
];
const BIRKENSTOCK_ADULT_MENS_US_ROWS: SizeSourceRow[] = [
  { uk: "7", us: ["7", "7.5"] },
  { uk: "7.5", us: ["8", "8.5"] },
  { uk: "8", us: ["9", "9.5"] },
  { uk: "9", us: ["10", "10.5"] },
  { uk: "9.5", us: ["11", "11.5"] },
  { uk: "10.5", us: ["12", "12.5"] },
  { uk: "11.5", us: ["13", "13.5"] },
  { uk: "12", us: ["14", "14.5"] },
  { uk: "13", us: ["15", "15.5"] },
  { uk: "14", us: ["16", "16.5"] },
  { uk: "14.5", us: ["17", "17.5"] },
];
const BIRKENSTOCK_KIDS_ROWS: SizeSourceRow[] = [
  { uk: "7", eu: "24", us: ["6", "6.5"] },
  { uk: "8", eu: "25", us: ["7", "7.5"] },
  { uk: "8.5", eu: "26", us: ["8", "8.5"] },
  { uk: "9", eu: "27", us: ["9", "9.5"] },
  { uk: "10", eu: "28", us: ["10", "10.5"] },
  { uk: "11", eu: "29", us: ["11", "11.5"] },
  { uk: "11.5", eu: "30", us: ["12", "12.5"] },
  { uk: "13", eu: "31", us: ["13", "13.5"] },
  { uk: "13.5", eu: "32", us: ["1", "1.5"] },
  { uk: "1", eu: "33", us: ["2", "2.5"] },
  { uk: "2", eu: "34", us: ["3", "3.5"] },
];

// Crocs: crocs.co.uk/pg/crocs-fit-guide-size-charts/fit-guide-landing.html,
// accessed 2026-07-30. Crocs' official page also publishes a third,
// internally-inconsistent "unisex combined" table alongside the separate
// Men's/Women's ones — the standalone tables are used here as the more
// specific, internally-consistent source. EU is published as a range for
// every UK size (e.g. UK7=41-42); under the strict no-collision rule this
// leaves real gaps where adjacent ranges overlap — expected, not a defect.
// Kids chart (C-series/J-series) overlaps — excluded, falls through to
// fallback. Category coverage: mens, womens. Both EU and US.
const CROCS_MENS_ROWS: SizeSourceRow[] = [
  { uk: "3", eu: ["36", "37"], us: "4" },
  { uk: "4", eu: ["37", "38"], us: "5" },
  { uk: "5", eu: ["38", "39"], us: "6" },
  { uk: "6", eu: ["39", "40"], us: "7" },
  { uk: "7", eu: ["41", "42"], us: "8" },
  { uk: "8", eu: ["42", "43"], us: "9" },
  { uk: "9", eu: ["43", "44"], us: "10" },
  { uk: "10", eu: ["45", "46"], us: "11" },
  { uk: "11", eu: ["46", "47"], us: "12" },
  { uk: "12", eu: ["48", "49"], us: "13" },
  { uk: "13", eu: ["49", "50"], us: "14" },
  { uk: "14", eu: ["50", "51"], us: "15" },
  { uk: "15", eu: ["51", "52"], us: "16" },
  { uk: "16", eu: ["52", "53"], us: "17" },
];
const CROCS_WOMENS_ROWS: SizeSourceRow[] = [
  { uk: "2", eu: ["33", "34"], us: "4" },
  { uk: "3", eu: ["34", "35"], us: "5" },
  { uk: "4", eu: ["36", "37"], us: "6" },
  { uk: "5", eu: ["37", "38"], us: "7" },
  { uk: "6", eu: ["38", "39"], us: "8" },
  { uk: "7", eu: ["39", "40"], us: "9" },
  { uk: "8", eu: ["41", "42"], us: "10" },
  { uk: "9", eu: ["42", "43"], us: "11" },
];

// Merrell: merrell.com/UK/en_GB/content?caid=20200330_size_guide, accessed
// 2026-07-30. Merrell publishes separate Footwear and Sandals US
// conversions per gender — the Footwear table is used here as the
// general-purpose default. Merrell's Kids "Little" (2-5yr) and "Big"
// (5+yr) charts are the one brand confirmed genuinely non-overlapping end
// to end (they share an identical UK2 row), so — unlike every other brand
// researched — a childrens table is included. Category coverage: mens,
// womens, childrens. Both EU and US.
const MERRELL_MENS_ROWS: SizeSourceRow[] = [
  { uk: "6.5", eu: "40", us: "7" },
  { uk: "7", eu: "41", us: "7.5" },
  { uk: "7.5", eu: "41.5", us: "8" },
  { uk: "8", eu: "42", us: "8.5" },
  { uk: "8.5", eu: "43", us: "9" },
  { uk: "9", eu: "43.5", us: "9.5" },
  { uk: "9.5", eu: "44", us: "10" },
  { uk: "10", eu: "44.5", us: "10.5" },
  { uk: "10.5", eu: "45", us: "11" },
  { uk: "11", eu: "46", us: "11.5" },
  { uk: "11.5", eu: "46.5", us: "12" },
  { uk: "12", eu: "47", us: "12.5" },
  { uk: "12.5", eu: "48", us: "13" },
  { uk: "13", eu: "49", us: "14" },
  { uk: "14", eu: "50", us: "15" },
  { uk: "15", eu: "51", us: "16" },
];
const MERRELL_WOMENS_ROWS: SizeSourceRow[] = [
  { uk: "2.5", eu: "35", us: "5" },
  { uk: "3", eu: "35.5", us: "5.5" },
  { uk: "3.5", eu: "36", us: "6" },
  { uk: "4", eu: "37", us: "6.5" },
  { uk: "4.5", eu: "37.5", us: "7" },
  { uk: "5", eu: "38", us: "7.5" },
  { uk: "5.5", eu: "38.5", us: "8" },
  { uk: "6", eu: "39", us: "8.5" },
  { uk: "6.5", eu: "40", us: "9" },
  { uk: "7", eu: "40.5", us: "9.5" },
  { uk: "7.5", eu: "41", us: "10" },
  { uk: "8", eu: "42", us: "10.5" },
  { uk: "8.5", eu: "42.5", us: "11" },
  { uk: "9", eu: "43", us: "11.5" },
];
const MERRELL_CHILDRENS_ROWS: SizeSourceRow[] = [
  { uk: "9", eu: "28", us: "10" },
  { uk: "10", eu: "29", us: "11" },
  { uk: "11", eu: "30", us: "12" },
  { uk: "12", eu: "31", us: "13" },
  { uk: "13", eu: "32", us: "1" },
  { uk: "1", eu: "33", us: "2" },
  { uk: "2", eu: "34", us: "3" },
  { uk: "3", eu: "35", us: "4" },
  { uk: "4", eu: "36", us: "5" },
  { uk: "5", eu: "37", us: "6" },
  { uk: "6", eu: "38", us: "7" },
];

// Clarks: clarks.com/en-gb/fitguide, accessed 2026-07-30. Clarks' official
// UK size-guide page does not publish US sizes at all, for any category —
// confirmed genuine gap, so Clarks has no US table. The EU value used is
// Clarks' own "Clarks EU" column (not the page's separate "Standard EU"
// column), since that's the number Clarks' own labels print. No childrens
// table: Clarks' kids chart resets UK numbering — excluded, falls through
// to generic fallback. Category coverage: mens, womens. EU only.
const CLARKS_MENS_ROWS: SizeSourceRow[] = [
  { uk: "5", eu: "38" },
  { uk: "5.5", eu: "39" },
  { uk: "6", eu: "39.5" },
  { uk: "6.5", eu: "40" },
  { uk: "7", eu: "41" },
  { uk: "7.5", eu: "41.5" },
  { uk: "8", eu: "42" },
  { uk: "8.5", eu: "42.5" },
  { uk: "9", eu: "43" },
  { uk: "9.5", eu: "44" },
  { uk: "10", eu: "44.5" },
  { uk: "10.5", eu: "45" },
  { uk: "11", eu: "46" },
  { uk: "12", eu: "47" },
  { uk: "13", eu: "48" },
  { uk: "14", eu: "49.5" },
];
const CLARKS_WOMENS_ROWS: SizeSourceRow[] = [
  { uk: "3", eu: "35.5" },
  { uk: "3.5", eu: "36" },
  { uk: "4", eu: "37" },
  { uk: "4.5", eu: "37.5" },
  { uk: "5", eu: "38" },
  { uk: "5.5", eu: "39" },
  { uk: "6", eu: "39.5" },
  { uk: "6.5", eu: "40" },
  { uk: "7", eu: "41" },
  { uk: "7.5", eu: "41.5" },
  { uk: "8", eu: "42" },
  { uk: "8.5", eu: "42.5" },
  { uk: "9", eu: "43" },
];

// Adidas: https://support.dtb.adidas.com/static-content/size-charts/en_GB/footwear/size-shoes.html
// (an adidas-owned support subdomain — the flagship adidas.com/us and
// adidas.co.uk/de/au/jp pages all returned 403), accessed 2026-08-03. This
// is Adidas' single combined footwear chart: EU is genuinely
// gender-invariant (one EU number per physical shoe size regardless of
// gender), while the US label differs by gender for that same physical
// size — modelled with a `unisex` EU table plus separate mens/womens US
// tables (see BrandGenderSizeMap's own comment). Adidas prints some EU
// sizes as thirds (e.g. "42 2/3") — kept exactly as published, not
// rounded, since that's the literal label text an AI extraction would read.
// No kids table sourced. Category coverage: mens, womens (US only) +
// unisex (EU). Both EU and US.
const ADIDAS_EU_AND_US_MENS_ROWS: SizeSourceRow[] = [
  { uk: "3.5", eu: "36", us: "4" },
  { uk: "4", eu: "36 2/3", us: "4.5" },
  { uk: "4.5", eu: "37 1/3", us: "5" },
  { uk: "5", eu: "38", us: "5.5" },
  { uk: "5.5", eu: "38 2/3", us: "6" },
  { uk: "6", eu: "39 1/3", us: "6.5" },
  { uk: "6.5", eu: "40", us: "7" },
  { uk: "7", eu: "40 2/3", us: "7.5" },
  { uk: "7.5", eu: "41 1/3", us: "8" },
  { uk: "8", eu: "42", us: "8.5" },
  { uk: "8.5", eu: "42 2/3", us: "9" },
  { uk: "9", eu: "43 1/3", us: "9.5" },
  { uk: "9.5", eu: "44", us: "10" },
  { uk: "10", eu: "44 2/3", us: "10.5" },
  { uk: "10.5", eu: "45 1/3", us: "11" },
  { uk: "11", eu: "46", us: "11.5" },
  { uk: "11.5", eu: "46 2/3", us: "12" },
  { uk: "12", eu: "47 1/3", us: "12.5" },
  { uk: "12.5", eu: "48", us: "13" },
  { uk: "13", eu: "48 2/3", us: "13.5" },
  { uk: "13.5", eu: "49 1/3", us: "14" },
  { uk: "14", eu: "50", us: "14.5" },
  { uk: "14.5", eu: "50 2/3", us: "15" },
  { uk: "15", eu: "51 1/3", us: "16" },
  { uk: "16", eu: "52 2/3", us: "17" },
  { uk: "17", eu: "53 1/3", us: "18" },
  { uk: "18", eu: "54 2/3", us: "19" },
  { uk: "19", eu: "55 2/3", us: "20" },
];
// Women's US label only — no separate EU column (Adidas' EU is unisex,
// read from the row above); the source's women's US column stops at
// UK14.5/US15.5, matching the official table's own published range.
const ADIDAS_US_WOMENS_ROWS: SizeSourceRow[] = [
  { uk: "3.5", us: "5" },
  { uk: "4", us: "5.5" },
  { uk: "4.5", us: "6" },
  { uk: "5", us: "6.5" },
  { uk: "5.5", us: "7" },
  { uk: "6", us: "7.5" },
  { uk: "6.5", us: "8" },
  { uk: "7", us: "8.5" },
  { uk: "7.5", us: "9" },
  { uk: "8", us: "9.5" },
  { uk: "8.5", us: "10" },
  { uk: "9", us: "10.5" },
  { uk: "9.5", us: "11" },
  { uk: "10", us: "11.5" },
  { uk: "10.5", us: "12" },
  { uk: "11", us: "12.5" },
  { uk: "11.5", us: "13" },
  { uk: "12", us: "13.5" },
  { uk: "12.5", us: "14" },
  { uk: "13", us: "14.5" },
  { uk: "13.5", us: "15" },
  { uk: "14.5", us: "15.5" },
];

// ASICS: https://www.asics.com/nz/en-nz/size-guide (the flagship asics.com,
// asics.co.uk, and US/AU/SG/IE/PL locales, plus an official PDF, all
// returned 403 — the NZ locale, an official asics.com-family domain, was
// reachable), accessed 2026-08-03. Separate Men's/Unisex and Women's
// tables, each with their own UK/EU/US columns; the two tables' own
// cross-reference columns for the opposite gender disagree with each
// other's direct data (the same inconsistency flagged for Crocs), so only
// each table's own direct UK/EU/US columns are used here. No kids table
// sourced. Category coverage: mens, womens. Both EU and US.
const ASICS_MENS_ROWS: SizeSourceRow[] = [
  { uk: "3", eu: "36", us: "4" },
  { uk: "4", eu: "37.5", us: "5" },
  { uk: "4.5", eu: "38", us: "5.5" },
  { uk: "5", eu: "39", us: "6" },
  { uk: "5.5", eu: "39.5", us: "6.5" },
  { uk: "6", eu: "40", us: "7" },
  { uk: "6.5", eu: "40.5", us: "7.5" },
  { uk: "7", eu: "41.5", us: "8" },
  { uk: "7.5", eu: "42", us: "8.5" },
  { uk: "8", eu: "42.5", us: "9" },
  { uk: "8.5", eu: "43.5", us: "9.5" },
  { uk: "9", eu: "44", us: "10" },
  { uk: "9.5", eu: "44.5", us: "10.5" },
  { uk: "10", eu: "45", us: "11" },
  { uk: "10.5", eu: "46", us: "11.5" },
  { uk: "11", eu: "46.5", us: "12" },
  { uk: "11.5", eu: "47", us: "12.5" },
  { uk: "12", eu: "48", us: "13" },
  { uk: "12.5", eu: "48.5", us: "13.5" },
  { uk: "13", eu: "49", us: "14" },
  { uk: "14", eu: "50.5", us: "15" },
  { uk: "15", eu: "51.5", us: "16" },
];
const ASICS_WOMENS_ROWS: SizeSourceRow[] = [
  { uk: "3", eu: "35.5", us: "5" },
  { uk: "3.5", eu: "36", us: "5.5" },
  { uk: "4", eu: "37", us: "6" },
  { uk: "4.5", eu: "37.5", us: "6.5" },
  { uk: "5", eu: "38", us: "7" },
  { uk: "5.5", eu: "39", us: "7.5" },
  { uk: "6", eu: "39.5", us: "8" },
  { uk: "6.5", eu: "40", us: "8.5" },
  { uk: "7", eu: "40.5", us: "9" },
  { uk: "7.5", eu: "41.5", us: "9.5" },
  { uk: "8", eu: "42", us: "10" },
  { uk: "8.5", eu: "42.5", us: "10.5" },
  { uk: "9", eu: "43.5", us: "11" },
  { uk: "9.5", eu: "44", us: "11.5" },
  { uk: "10", eu: "44.5", us: "12" },
  { uk: "10.5", eu: "45", us: "12.5" },
  { uk: "11", eu: "46", us: "13" },
];

// Brands researched twice (2026-07-30 and 2026-08-03) with no official,
// verifiable brand-specific data obtained — every official domain/locale
// tried sits behind bot-protection (403/CAPTCHA), with no accessible PDF
// or embedded-JSON/API fallback either:
//   - On: no numeric UK/EU/US chart exists anywhere on on.com at all (only
//     one qualitative note: "women's is men's US +1.5") — not a blocked
//     page, a genuine absence of a chart to source from.
//   - Hoka: every hoka.com locale blocked; Hoka's own help centre confirms
//     sizing only ever appears per-product next to the (also blocked)
//     size selector — no general chart page exists to fall back on.
//   - UGG: every ugg.com locale, PDF search, and product-page/API probe
//     blocked outright (DataDome "header overflow"/CAPTCHA at every turn).
// Listed here (rather than silently omitted) so this is a documented,
// checked absence, not an oversight. All of these still resolve through
// the generic fallback whenever category is known.
export const EXCLUDED_BRANDS_NO_OFFICIAL_DATA = ["on", "hoka", "ugg"] as const;

// Keyed by normalized (trim + lowercase) brand name — matches the brand
// examples in LISTING_GENERATION_SYSTEM_PROMPT. A brand present here but
// missing a system/category entry, or absent entirely, always falls
// through to GENERIC_FALLBACK_TABLE — never silently unsupported when the
// fallback has an exact, unambiguous match (see convertSourceSizeToUk).
const BRAND_SIZE_CONVERSION_TABLES: Record<string, BrandSizeConversionTable> = {
  adidas: {
    EU: { unisex: buildExactUkReverseMap(ADIDAS_EU_AND_US_MENS_ROWS, "eu") },
    US: { mens: buildExactUkReverseMap(ADIDAS_EU_AND_US_MENS_ROWS, "us"), womens: buildExactUkReverseMap(ADIDAS_US_WOMENS_ROWS, "us") },
  },
  asics: {
    EU: { mens: buildExactUkReverseMap(ASICS_MENS_ROWS, "eu"), womens: buildExactUkReverseMap(ASICS_WOMENS_ROWS, "eu") },
    US: { mens: buildExactUkReverseMap(ASICS_MENS_ROWS, "us"), womens: buildExactUkReverseMap(ASICS_WOMENS_ROWS, "us") },
  },
  salomon: {
    EU: { mens: buildExactUkReverseMap(SALOMON_MENS_ROWS, "eu"), womens: buildExactUkReverseMap(SALOMON_WOMENS_ROWS, "eu") },
    US: { mens: buildExactUkReverseMap(SALOMON_MENS_ROWS, "us"), womens: buildExactUkReverseMap(SALOMON_WOMENS_ROWS, "us") },
  },
  birkenstock: {
    EU: {
      unisex: buildExactUkReverseMap(BIRKENSTOCK_ADULT_EU_ROWS, "eu"),
      childrens: buildExactUkReverseMap(BIRKENSTOCK_KIDS_ROWS, "eu"),
    },
    US: {
      mens: buildExactUkReverseMap(BIRKENSTOCK_ADULT_MENS_US_ROWS, "us"),
      womens: buildExactUkReverseMap(BIRKENSTOCK_ADULT_WOMENS_US_ROWS, "us"),
      childrens: buildExactUkReverseMap(BIRKENSTOCK_KIDS_ROWS, "us"),
    },
  },
  nike: {
    EU: { mens: buildExactUkReverseMap(NIKE_MENS_ROWS, "eu"), womens: buildExactUkReverseMap(NIKE_WOMENS_ROWS, "eu") },
    US: { mens: buildExactUkReverseMap(NIKE_MENS_ROWS, "us"), womens: buildExactUkReverseMap(NIKE_WOMENS_ROWS, "us") },
  },
  "new balance": {
    EU: { mens: buildExactUkReverseMap(NEW_BALANCE_MENS_ROWS, "eu"), womens: buildExactUkReverseMap(NEW_BALANCE_WOMENS_ROWS, "eu") },
    US: { mens: buildExactUkReverseMap(NEW_BALANCE_MENS_ROWS, "us"), womens: buildExactUkReverseMap(NEW_BALANCE_WOMENS_ROWS, "us") },
  },
  timberland: {
    EU: { mens: buildExactUkReverseMap(TIMBERLAND_MENS_ROWS, "eu"), womens: buildExactUkReverseMap(TIMBERLAND_WOMENS_ROWS, "eu") },
    US: { mens: buildExactUkReverseMap(TIMBERLAND_MENS_ROWS, "us"), womens: buildExactUkReverseMap(TIMBERLAND_WOMENS_ROWS, "us") },
  },
  "dr martens": {
    EU: { mens: buildExactUkReverseMap(DR_MARTENS_MENS_ROWS, "eu"), womens: buildExactUkReverseMap(DR_MARTENS_WOMENS_ROWS, "eu") },
    US: { mens: buildExactUkReverseMap(DR_MARTENS_MENS_ROWS, "us"), womens: buildExactUkReverseMap(DR_MARTENS_WOMENS_ROWS, "us") },
  },
  crocs: {
    EU: { mens: buildExactUkReverseMap(CROCS_MENS_ROWS, "eu"), womens: buildExactUkReverseMap(CROCS_WOMENS_ROWS, "eu") },
    US: { mens: buildExactUkReverseMap(CROCS_MENS_ROWS, "us"), womens: buildExactUkReverseMap(CROCS_WOMENS_ROWS, "us") },
  },
  merrell: {
    EU: {
      mens: buildExactUkReverseMap(MERRELL_MENS_ROWS, "eu"),
      womens: buildExactUkReverseMap(MERRELL_WOMENS_ROWS, "eu"),
      childrens: buildExactUkReverseMap(MERRELL_CHILDRENS_ROWS, "eu"),
    },
    US: {
      mens: buildExactUkReverseMap(MERRELL_MENS_ROWS, "us"),
      womens: buildExactUkReverseMap(MERRELL_WOMENS_ROWS, "us"),
      childrens: buildExactUkReverseMap(MERRELL_CHILDRENS_ROWS, "us"),
    },
  },
  clarks: {
    EU: { mens: buildExactUkReverseMap(CLARKS_MENS_ROWS, "eu"), womens: buildExactUkReverseMap(CLARKS_WOMENS_ROWS, "eu") },
    // No US entry at all for Clarks — see this file's own comment above.
  },
};

// Exposed for tests/documentation — the exact, current set of brands with
// any brand-specific conversion support at all. A brand NOT in this list
// still resolves via the generic fallback whenever the category is known
// and the exact value is unambiguous — see convertSourceSizeToUk.
export const SUPPORTED_SIZE_CONVERSION_BRANDS = Object.keys(BRAND_SIZE_CONVERSION_TABLES);

function normalizeBrand(brand: string): string {
  return brand.trim().toLowerCase();
}

/**
 * Resolves which category-specific map to use for one brand+system, or
 * null if unsupported/genuinely ambiguous:
 * - "childrens" always uses the brand's childrens table if it has one,
 *   otherwise null (never substituted with an adult table).
 * - "womens" uses the brand's own womens table if it has one, otherwise
 *   its `unisex` table if the brand's own chart states this system is
 *   gender-invariant (e.g. Adidas' EU column) — never falls back to
 *   `mens`, which would risk misconverting a real gender difference.
 * - "mens" uses the brand's own mens table, otherwise `unisex` if present.
 * - "unisex" uses the brand's own `unisex` table if present, otherwise
 *   `mens` — the conventional reading for athletic/outdoor footwear absent
 *   a brand publishing a distinct unisex chart.
 * - no category stated: resolved only when there's nothing to choose
 *   between — a lone `unisex` table, or exactly one of mens/womens with no
 *   unisex table either; genuinely ambiguous — and so null — whenever
 *   mens AND womens are both present (a real, brand-stated divergence).
 *   Never auto-resolves into childrens.
 */
function resolveBrandCategoryMap(systemTable: BrandGenderSizeMap, category: SizeCategory | null): SizeConversionMap | null {
  if (category === "childrens") return systemTable.childrens ?? null;
  if (category === "womens") return systemTable.womens ?? systemTable.unisex ?? null;
  if (category === "mens") return systemTable.mens ?? systemTable.unisex ?? null;
  if (category === "unisex") return systemTable.unisex ?? systemTable.mens ?? null;
  if (systemTable.mens && systemTable.womens) return null; // ambiguous — don't guess which
  return systemTable.unisex ?? systemTable.mens ?? systemTable.womens ?? null;
}

/**
 * Same idea as resolveBrandCategoryMap, but for the generic fallback,
 * which always has both a mensUnisex and a womens table — meaning an
 * unstated category is ALWAYS ambiguous here (mens/unisex vs womens is a
 * real fork with no brand-level context to narrow it), and childrens is
 * only ever used when explicitly stated.
 */
function resolveFallbackCategoryMap(
  systemTable: { mensUnisex: SizeConversionMap; womens: SizeConversionMap; childrens: SizeConversionMap },
  category: SizeCategory | null,
): SizeConversionMap | null {
  if (category === "childrens") return systemTable.childrens;
  if (category === "womens") return systemTable.womens;
  if (category === "mens" || category === "unisex") return systemTable.mensUnisex;
  return null;
}

/**
 * Brand-aware, exact-match-only EU/US -> UK conversion, falling through to
 * the generic category-separated fallback whenever the brand-specific
 * lookup doesn't produce a result — for ANY reason (brand entirely
 * unsupported, brand known but no chart for this system, or an exact size
 * this brand's table doesn't have, including one excluded for being
 * ambiguous) — since all of these are the same "nothing more specific
 * available" case from the caller's point of view. Never an estimate or
 * interpolation at either tier, and never an arbitrary pick between two
 * colliding candidates: exact, unambiguous match or null (see
 * buildExactUkReverseMap's own comment for how ambiguous values are
 * excluded from every table up front).
 */
export function convertSourceSizeToUk(params: {
  brand: string | null;
  system: ConvertibleSizeSystem;
  value: string;
  category: SizeCategory | null;
}): SizeConversionResult {
  const value = params.value.trim();

  if (params.brand) {
    const brandTable = BRAND_SIZE_CONVERSION_TABLES[normalizeBrand(params.brand)];
    const systemTable = brandTable?.[params.system];
    const categoryMap = systemTable ? resolveBrandCategoryMap(systemTable, params.category) : null;
    const brandMatch = categoryMap?.[value];
    if (brandMatch) return { ukSize: brandMatch, provenance: "brand_converted" };
  }

  const fallbackSystemTable = GENERIC_FALLBACK_TABLE[params.system];
  const fallbackMap = resolveFallbackCategoryMap(fallbackSystemTable, params.category);
  const fallbackMatch = fallbackMap?.[value];
  if (fallbackMatch) return { ukSize: fallbackMatch, provenance: "fallback_converted" };

  return { ukSize: null, provenance: null };
}

/**
 * The single entry point the generate route calls: implements the full
 * size-precedence rule (a directly observed UK size always wins, never
 * converted or second-guessed) before falling through brand-specific then
 * generic-fallback EU/US conversion, and normalizes a partial/inconsistent
 * source-size pair (one of system/value present without the other) to "no
 * usable source size" rather than guessing. The returned provenance is
 * what gets persisted alongside uk_size, so a regeneration can tell a
 * manually-entered value (recorded separately, by the fields route) apart
 * from one this function produced.
 */
export function deriveUkSizeFromSource(params: {
  brand: string | null;
  sourceSizeSystem: SourceSizeSystem | null;
  sourceSizeValue: string | null;
  sourceSizeGender: SizeCategory | null;
}): SizeConversionResult {
  const { sourceSizeSystem, sourceSizeValue } = params;
  if (!sourceSizeSystem || !sourceSizeValue) return { ukSize: null, provenance: null };
  if (sourceSizeSystem === "UK") return { ukSize: sourceSizeValue, provenance: "observed" };
  return convertSourceSizeToUk({ brand: params.brand, system: sourceSizeSystem, value: sourceSizeValue, category: params.sourceSizeGender });
}
