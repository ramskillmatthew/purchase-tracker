import { londonToday } from "@/lib/sales/report-date-range";

export type FinanceRangePreset = "7" | "30" | "90" | "custom";

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function validDate(value: string | null | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

export function resolveFinanceRange(input: { preset?: string | null; start?: string | null; end?: string | null }, today = londonToday()) {
  const preset: FinanceRangePreset = input.preset === "7" || input.preset === "90" || input.preset === "custom" ? input.preset : "30";
  if (preset === "custom") {
    if (!validDate(input.start) || !validDate(input.end) || input.start > input.end) {
      return { ok: false as const, error: "Choose a valid custom date range." };
    }
    return { ok: true as const, range: { preset, start: input.start, end: input.end } };
  }
  return { ok: true as const, range: { preset, start: today, end: addDays(today, Number(preset) - 1) } };
}
