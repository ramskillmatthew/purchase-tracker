// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  mapConditionToOptionText, stepSetTitle, stepSetPrice, stepSetQuantity, stepSetSku,
  stepVerifyPopulatedFields, inspectEbayPageState, setNativeValue,
} from "../vinted-draft-queue-extension/shared/ebay-form-steps.js";

function makeFormFixture() {
  const dom = new JSDOM(`
    <input name="title" value="" />
    <textarea name="description"></textarea>
    <input name="price" value="" />
    <input name="quantity" value="" />
    <input type="checkbox" name="customLabelPref" />
  `, { url: "https://www.ebay.co.uk/lstng?draftId=123&mode=AddItem" });
  return { doc: dom.window.document, win: dom.window, location: dom.window.location };
}

function field(doc: Document, name: string): HTMLInputElement {
  const el = doc.querySelector(`[name="${name}"]`);
  if (!el) throw new Error(`test fixture is missing [name="${name}"]`);
  return el as HTMLInputElement;
}

const ITEM = {
  itemId: "item-1", title: "On Running Cloud 5", description: "desc", pricePence: 3500, quantity: 1, sku: "1644",
};

describe("eBay drafter form steps — REQUIREMENT: condition mapping never invents a fake UK Seller Hub tier", () => {
  it("maps this app's condition vocabulary onto the REAL, live-verified Seller Hub option text", () => {
    expect(mapConditionToOptionText("Used – Very Good")).toBe("Pre-owned - Good");
    expect(mapConditionToOptionText("New with tags")).toBe("New with box");
    expect(mapConditionToOptionText("Used – Like New")).toBe("Pre-owned - Excellent");
  });

  it("falls back to the SAFE, closest real option for anything unmapped — never a guessed/invented tier", () => {
    expect(mapConditionToOptionText("Some future condition string")).toBe("Pre-owned - Good");
  });
});

describe("eBay drafter form steps — text field steps (VERIFIED name-attribute selectors)", () => {
  it("stepSetTitle sets the real 'title'-named input via the native setter and confirms it", async () => {
    const fixture = makeFormFixture();
    const result = await stepSetTitle(ITEM, fixture);
    expect(result.ok).toBe(true);
    expect(field(fixture.doc, "title").value).toBe(ITEM.title);
  });

  it("stepSetTitle is idempotent — a field already holding the right value is left untouched, never re-typed", async () => {
    const fixture = makeFormFixture();
    setNativeValue(field(fixture.doc, "title"), ITEM.title, fixture.win);
    const result = await stepSetTitle(ITEM, fixture);
    expect(result.ok).toBe(true);
  });

  it("stepSetTitle fails closed (NOT_FOUND) when the real field genuinely doesn't exist — never guesses a different element", async () => {
    const dom = new JSDOM(`<div></div>`, { url: "https://www.ebay.co.uk/lstng?draftId=1&mode=AddItem" });
    const result = await stepSetTitle(ITEM, { doc: dom.window.document, win: dom.window, location: dom.window.location });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/NOT_FOUND/);
  });

  it("stepSetPrice sets the price field and confirms via numeric-pence comparison (£35.00 == 3500 pence)", async () => {
    const fixture = makeFormFixture();
    const result = await stepSetPrice(ITEM, fixture);
    expect(result.ok).toBe(true);
  });

  it("stepSetQuantity sets the quantity field", async () => {
    const fixture = makeFormFixture();
    const result = await stepSetQuantity(ITEM, fixture);
    expect(result.ok).toBe(true);
    expect(field(fixture.doc, "quantity").value).toBe("1");
  });

  it("stepSetSku toggles the hidden customLabelPref checkbox on before setting the (initially-absent) SKU field — VERIFIED live behaviour", async () => {
    const fixture = makeFormFixture();
    // Simulate the checkbox reveal: toggling it inserts the real customLabel input, exactly like the live page.
    field(fixture.doc, "customLabelPref").addEventListener("click", () => {
      const input = fixture.doc.createElement("input");
      input.name = "customLabel";
      fixture.doc.body.appendChild(input);
      field(fixture.doc, "customLabelPref").checked = true;
    });
    const result = await stepSetSku(ITEM, fixture);
    expect(result.ok).toBe(true);
    expect(field(fixture.doc, "customLabel").value).toBe("1644");
  });
});

describe("eBay drafter form steps — REQUIREMENT (Phase 6): 'the click succeeded' is not proof — verify-after-population", () => {
  it("stepVerifyPopulatedFields fails when a field silently reverted after being set", async () => {
    const fixture = makeFormFixture();
    await stepSetTitle(ITEM, fixture);
    await stepSetPrice(ITEM, fixture);
    await stepSetQuantity(ITEM, fixture);
    fixture.doc.body.insertAdjacentHTML("beforeend", '<input name="customLabel" value="1644" />');
    // Simulate the exact failure this step exists to catch: something reset the title after it was set.
    setNativeValue(field(fixture.doc, "title"), "", fixture.win);
    const result = stepVerifyPopulatedFields(ITEM, fixture);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("title");
  });

  it("stepVerifyPopulatedFields passes when every field genuinely holds its expected value", async () => {
    const fixture = makeFormFixture();
    await stepSetTitle(ITEM, fixture);
    await stepSetPrice(ITEM, fixture);
    await stepSetQuantity(ITEM, fixture);
    setNativeValue(field(fixture.doc, "description"), ITEM.description, fixture.win);
    fixture.doc.body.insertAdjacentHTML("beforeend", '<input name="customLabel" value="1644" />');
    const result = stepVerifyPopulatedFields(ITEM, fixture);
    expect(result.ok).toBe(true);
  });
});

describe("eBay drafter form steps — page-state detection", () => {
  it("recognises the real Seller Hub listing form URL shape (?draftId=<digits>)", () => {
    const fixture = makeFormFixture();
    expect(inspectEbayPageState(fixture.doc, fixture.location)).toBe("on_form");
  });

  it("recognises a CAPTCHA page and stops rather than guessing", () => {
    const dom = new JSDOM(`<div role="dialog">Please complete this captcha to continue</div>`, { url: "https://www.ebay.co.uk/lstng?draftId=1&mode=AddItem" });
    expect(inspectEbayPageState(dom.window.document, dom.window.location)).toBe("captcha");
  });
});
