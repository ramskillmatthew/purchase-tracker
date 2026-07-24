import { describe, expect, it } from "vitest"; import { parseVintedEmail } from "@/lib/vinted/parser";
const base={messageId:"<anon-123@example.test>",sender:"Vinted <orders@email.vinted.com>",date:"2026-07-10T10:00:00.000Z"};
describe("deterministic Vinted parser",()=>{
  it("extracts a genuine purchase without inventing condition",()=>{
    const row=parseVintedEmail({...base,subject:"Your purchase is confirmed",text:"Order number: AB-12345\nItem: Blue jacket\nSeller: sample_seller\nSize: M\nTotal: £18.50"});
    expect(row).toMatchObject({orderReference:"AB-12345",sellerName:"sample_seller",totalPaidPence:1850});
    expect(row?.items).toEqual([{description:"Blue jacket",size:"M",condition:null,quantity:1,linePricePence:null}]);
  });
  it.each(["Your order was dispatched","Your order was delivered","Your order was cancelled","Your payment was refunded","Your payment is being sent to your bank","This order is completed"])("rejects non-purchase lifecycle mail: %s",subject=>{expect(parseVintedEmail({...base,messageId:`<${subject}@example.test>`,subject,text:"Order number: AB-12345"})).toBeNull();});
  it("rejects unknown formats and non-Vinted senders",()=>{expect(parseVintedEmail({...base,subject:"Newsletter",text:"Hello"})).toBeNull();expect(parseVintedEmail({...base,sender:"attacker@example.test",subject:"Your purchase",text:"Order: 12345"})).toBeNull();});
  it("rejects seller-side sale and shipping notifications",()=>{expect(parseVintedEmail({...base,subject:"You’ve sold an item on Vinted",text:"Payment received. Make sure to send your item to the buyer."})).toBeNull();expect(parseVintedEmail({...base,messageId:"<sale-2@example.test>",subject:"Your item has sold",text:"Order number: SALE-123"})).toBeNull();});
  it("parses an iCloud-forwarded Vinted receipt after table text is collapsed",()=>{
    const row=parseVintedEmail({messageId:"<receipt@example.test>",sender:"iCloud <noreply@icloud.example>",subject:'Your receipt for “Anonymised Running Shoe”',date:"2026-06-09T20:15:00.000Z",text:"Your payment has been received. Your Vinted purchase receipt: Seller sample_seller Order Anonymised Running Shoe Paid £14.19 Item £10.00 Postage £2.99 Buyer Protection fee £1.20 Payment date 09/06/2026 20:09 Transaction ID 2030000000"});
    expect(row).toMatchObject({orderReference:"2030000000",sellerName:"sample_seller",totalPaidPence:1419,purchaseDate:"2026-06-09"});
    expect(row?.items[0].description).toBe("Anonymised Running Shoe");
  });
  it("creates a stable conservative fallback fingerprint",()=>{const input={...base,subject:"Purchase confirmed",text:"Item: Coat\nSeller: seller_a\nTotal: £20"};expect(parseVintedEmail(input)?.fingerprint).toBe(parseVintedEmail(input)?.fingerprint);});

  describe("condition extraction: reliable mapping, otherwise left for review (REGRESSION)", () => {
    it("maps Vinted's own condition wording to the canonical enum when stated reliably", () => {
      const row = parseVintedEmail({ ...base, subject: "Your purchase is confirmed", text: "Order number: AB-900\nItem: Wool Coat\nCondition: New with tags\nSize: M\nTotal: £30.00" });
      expect(row?.items[0].condition).toBe("Brand new");
    });
    it.each([
      ["New without tags", "Brand new without tags"],
      ["Very good", "Labelled as very good condition"],
      ["Good", "Good condition from photos"],
      ["Satisfactory", "Decent condition from photos"],
    ])("maps '%s' to '%s'", (raw, mapped) => {
      const row = parseVintedEmail({ ...base, subject: "Your purchase is confirmed", text: `Order number: AB-901\nItem: Wool Coat\nCondition: ${raw}\nTotal: £30.00` });
      expect(row?.items[0].condition).toBe(mapped);
    });
    it("REGRESSION: leaves condition null (never guessed) and flags for review when Vinted's wording doesn't confidently map", () => {
      const row = parseVintedEmail({ ...base, subject: "Your purchase is confirmed", text: "Order number: AB-902\nItem: Wool Coat\nCondition: Pristine as new\nTotal: £30.00" });
      expect(row?.items[0].condition).toBeNull();
      expect(row?.uncertaintyReasons).toContain("Condition could not be reliably determined; please review.");
    });
    it("leaves condition null when no condition wording is present at all", () => {
      const row = parseVintedEmail({ ...base, subject: "Your purchase is confirmed", text: "Order number: AB-903\nItem: Wool Coat\nTotal: £30.00" });
      expect(row?.items[0].condition).toBeNull();
    });
  });

  describe("multi-item and quantity expansion (REGRESSION — a single email is no longer assumed to be a single purchase row)", () => {
    it("REGRESSION: a bundle of distinct items with individual prices becomes separate item entries", () => {
      const row = parseVintedEmail({ ...base, subject: "Your purchase is confirmed", text: "Order number: AB-910\nItem Blue Jacket £10.00\nItem Red Scarf £5.00\nPaid £15.00" });
      expect(row?.items).toHaveLength(2);
      expect(row?.items.map(item => item.description)).toEqual(["Blue Jacket", "Red Scarf"]);
      expect(row?.items.map(item => item.linePricePence)).toEqual([1000, 500]);
      expect(row?.totalPaidPence).toBe(1500);
    });

    it("REGRESSION: a quantity marker on a single item expands it to that many units, not one row with a hidden multiplier", () => {
      const row = parseVintedEmail({ ...base, subject: "Your purchase is confirmed", text: "Order number: AB-911\nItem: Trading Cards\nQuantity: 3\nPaid £30.00" });
      expect(row?.items).toEqual([{ description: "Trading Cards", size: null, condition: null, quantity: 3, linePricePence: null }]);
      expect(row?.totalPaidPence).toBe(3000);
    });

    it("a single item with no quantity marker stays quantity 1", () => {
      const row = parseVintedEmail({ ...base, subject: "Your purchase is confirmed", text: "Order number: AB-912\nItem: Solo Item\nPaid £12.00" });
      expect(row?.items[0].quantity).toBe(1);
    });
  });
});
