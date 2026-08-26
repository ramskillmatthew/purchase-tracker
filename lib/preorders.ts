export type PreorderStatus = "Awaiting release" | "Payment pending" | "Dispatched" | "Delivered" | "Cancelled";

export type Preorder = {
  id: string;
  orderNumber: string;
  customerName: string;
  postcode: string;
  address: string;
  addressLine2?: string;
  townCity?: string;
  addressOwner?: string;
  preorderType: string;
  product: string;
  variant: string;
  quantity: number;
  retailer: string;
  orderDate: string;
  releaseDate: string;
  unitPrice: number;
  postage: number;
  status: PreorderStatus;
  paymentMethod: string;
  accountEmail: string;
  notes: string;
  imageUrl?: string;
};

export const preorderSamples: Preorder[] = [
  { id: "po-1", orderNumber: "E0006433376", customerName: "Matthew Ramskill", postcode: "HG5 8PJ", address: "1 Grimbald Cragg", townCity: "Knaresborough", addressOwner: "Matthew's address", preorderType: "Pokémon TCG", product: "Mega Evolution—Phantasmal Flames", variant: "Pokémon Center Elite Trainer Box", quantity: 2, retailer: "Pokémon Center UK", orderDate: "2026-07-15", releaseDate: "2026-09-26", unitPrice: 54.99, postage: 0, status: "Awaiting release", paymentMethod: "Visa •• 1842", accountEmail: "matthew@example.com", notes: "Keep sealed for long-term stock." },
  { id: "po-2", orderNumber: "E0006434314", customerName: "Andrew Ramskill", postcode: "HG5 8PJ", address: "1 Grimbald Cragg", townCity: "Knaresborough", addressOwner: "Matthew's address", preorderType: "Pokémon TCG", product: "Mega Evolution—Phantasmal Flames", variant: "Booster Display Box (36 packs)", quantity: 1, retailer: "Pokémon Center UK", orderDate: "2026-07-15", releaseDate: "2026-09-26", unitPrice: 143.64, postage: 0, status: "Payment pending", paymentMethod: "Mastercard •• 0291", accountEmail: "andrew@example.com", notes: "Payment captured at dispatch." },
  { id: "po-3", orderNumber: "E0006428017", customerName: "Caroline Ramskill", postcode: "S60 5TZ", address: "14 Willow View, Rotherham", preorderType: "Pokémon TCG", product: "Mega Evolution—Phantasmal Flames", variant: "Pokémon Center Elite Trainer Box", quantity: 2, retailer: "Pokémon Center UK", orderDate: "2026-07-15", releaseDate: "2026-09-26", unitPrice: 54.99, postage: 0, status: "Awaiting release", paymentMethod: "Visa •• 7004", accountEmail: "caroline@example.com", notes: "" },
  { id: "po-4", orderNumber: "GW-884921", customerName: "Matthew Ramskill", postcode: "YO26 6QW", address: "Unit 4, Westfield Park, York", preorderType: "Warhammer", product: "Horus Heresy—Saturnine", variant: "Launch box", quantity: 3, retailer: "Games Workshop", orderDate: "2026-07-19", releaseDate: "2026-10-03", unitPrice: 145, postage: 0, status: "Awaiting release", paymentMethod: "PayPal", accountEmail: "stock@example.com", notes: "Business stock delivery." },
  { id: "po-5", orderNumber: "AMZ-205144", customerName: "Beth Ramskill", postcode: "LS22 6LT", address: "8 Market Place, Wetherby", preorderType: "LEGO", product: "The Lord of the Rings: Minas Tirith", variant: "Collector set", quantity: 1, retailer: "Amazon UK", orderDate: "2026-08-01", releaseDate: "2026-11-01", unitPrice: 429.99, postage: 0, status: "Payment pending", paymentMethod: "Amex •• 1008", accountEmail: "beth@example.com", notes: "Watch for Amazon price guarantee adjustment." },
  { id: "po-6", orderNumber: "E0006422992", customerName: "Jean Ramskill", postcode: "HG5 8PJ", address: "1 Grimbald Cragg, Knaresborough", preorderType: "Pokémon TCG", product: "Mega Evolution—Phantasmal Flames", variant: "Booster Display Box (36 packs)", quantity: 1, retailer: "Pokémon Center UK", orderDate: "2026-07-15", releaseDate: "2026-09-26", unitPrice: 143.64, postage: 0, status: "Awaiting release", paymentMethod: "Visa •• 4720", accountEmail: "jean@example.com", notes: "" },
];

export const PREORDER_STORAGE_KEY = "trotters:preorders:v1";

export function orderTotal(order: Preorder) { return order.quantity * order.unitPrice + order.postage; }
export function formatMoney(value: number) { return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value); }
export function formatDate(value: string) { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`)); }
export function normalizePostcode(value: string) { return value.trim().toUpperCase().replace(/\s+/g, " "); }

export function loadPreorders(): Preorder[] {
  if (typeof window === "undefined") return preorderSamples;
  try {
    const saved = window.localStorage.getItem(PREORDER_STORAGE_KEY);
    return saved ? JSON.parse(saved) as Preorder[] : preorderSamples;
  } catch { return preorderSamples; }
}

export function savePreorders(rows: Preorder[]) {
  window.localStorage.setItem(PREORDER_STORAGE_KEY, JSON.stringify(rows));
  window.dispatchEvent(new Event("preorders-changed"));
}

export function daysUntil(value: string) {
  return Math.ceil((new Date(`${value}T12:00:00`).getTime() - Date.now()) / 86_400_000);
}
