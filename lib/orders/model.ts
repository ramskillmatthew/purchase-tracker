// Order Reconstruction data model. Transient, in-memory reasoning over
// already-fetched email content — no persistence, no database table. This
// is deliberately a separate domain from lib/vinted's `purchases` table
// (explicit, user-confirmed import), which this does not touch.

// "confirmed" is reserved for forward-compatibility with the requested event
// vocabulary but is not emitted in v1: a classifySubject === "confirmation"
// email always produces a single "ordered" event, since there is no
// reliable signal in this codebase to distinguish "order placed" from
// "order confirmed by retailer" as two separate moments — they are almost
// always the same email, and fabricating two timeline entries from one
// source email would invent a fact that isn't there.
export type OrderEventType = "ordered" | "confirmed" | "dispatched" | "out_for_delivery" | "delivered" | "cancelled" | "returned" | "refund_processed" | "sold";
export type OrderStatus = OrderEventType | "unknown";

export type OrderEvent = { type: OrderEventType; date: string | null; sourceEmailId: string };

export type ReconstructedOrder = {
  orderId: string | null;
  merchant: string;
  purchaseDate: string | null;
  status: OrderStatus;
  items: string[];
  trackingNumbers: string[];
  // The price paid at checkout, extracted from a confirmation-typed email
  // (e.g. "Total paid £24.00") — distinct from refundAmount below. An order
  // can have one, both, or neither known: a refund being known does not
  // imply the purchase price is known, and vice versa. Keeping these as two
  // separate fields (rather than one generic "amount") is what lets
  // synthesis correctly say "I can't determine the purchase price, but a
  // refund of £X was issued" instead of conflating the two or claiming no
  // pricing information exists at all when one of the two is in fact known.
  purchaseAmount: number | null;
  refundAmount: number | null;
  currency: string | null;
  timeline: OrderEvent[];
  sourceEmails: string[];
  // Internal only — how the grouping was formed (shared order reference vs.
  // merchant+date-window heuristic vs. an orphaned single event). Used for
  // future debugging, testing, and UI work. Never shown to Claude — see
  // lib/orders/render.ts, which deliberately omits this field.
  confidence: number;
};

export type OrderSourceEmail = { id: string; sender: string; subject: string; date: string | null; text: string; html: string };
