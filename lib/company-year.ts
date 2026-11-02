export const COMPANY_YEAR_STORAGE_KEY = "purchase-tracker-company-year-start";
export const COMPANY_YEAR_CHANGED_EVENT = "purchase-company-year-change";
export const DEFAULT_COMPANY_YEAR_START = "04-15";

export type CompanyYearStart = { month: number; day: number };

export function parseCompanyYearStart(value: string | null | undefined): CompanyYearStart {
  const match = /^(\d{2})-(\d{2})$/.exec(value || "");
  const month = Number(match?.[1]);
  const day = Number(match?.[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day)) return { month: 4, day: 15 };
  const maximum = new Date(2024, month, 0).getDate();
  return day >= 1 && day <= maximum ? { month, day } : { month: 4, day: 15 };
}

export function companyYearStartValue(start: CompanyYearStart): string {
  return `${String(start.month).padStart(2, "0")}-${String(start.day).padStart(2, "0")}`;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function companyYearDates(now: Date, start: CompanyYearStart) {
  const candidate = new Date(now.getFullYear(), start.month - 1, start.day);
  const startDate = now >= candidate ? candidate : new Date(now.getFullYear() - 1, start.month - 1, start.day);
  const endDate = new Date(startDate.getFullYear() + 1, start.month - 1, start.day);
  endDate.setDate(endDate.getDate() - 1);
  return { start: dateKey(startDate), today: dateKey(now), end: dateKey(endDate) };
}

export function companyYearLabel(start: CompanyYearStart): string {
  const startDate = new Date(2024, start.month - 1, start.day);
  const endDate = new Date(2025, start.month - 1, start.day);
  endDate.setDate(endDate.getDate() - 1);
  const format = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  return `${format(startDate)} to ${format(endDate)}`;
}
