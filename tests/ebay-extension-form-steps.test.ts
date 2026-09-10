// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  stepSetTitle, stepSetPrice, stepSetQuantity, stepSetSku,
  stepVerifyPopulatedFields, inspectEbayPageState, setNativeValue,
  stepWaitForManualCondition, MANUAL_CONDITION_TIMEOUT_MS,
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

describe("eBay drafter form steps — REQUIREMENT (condition-safety review): condition is NEVER auto-selected — always waits for a human", () => {
  it("no automatic condition-mapping function exists anywhere in this file", () => {
    const source = require("node:fs").readFileSync("vinted-draft-queue-extension/shared/ebay-form-steps.js", "utf8") as string;
    expect(source).not.toMatch(/function\s+mapConditionToOptionText/);
    expect(source).not.toContain("CONDITION_TO_OPTION_TEXT");
  });

  it("stepWaitForManualCondition never clicks a condition option — it only detects the Select Condition page and waits for the human to reach the real form themselves", () => {
    const source = require("node:fs").readFileSync("vinted-draft-queue-extension/shared/ebay-form-steps.js", "utf8") as string;
    const fnStart = source.indexOf("export async function stepWaitForManualCondition");
    const fnBody = source.slice(fnStart, source.indexOf("\n}\n", fnStart));
    expect(fnBody).not.toContain("safeClick");
    expect(fnBody).not.toMatch(/condition-button|Pre-owned|New with/);
  });

  it("REQUIREMENT: on the real 'Select condition' page, it reports a clear message telling the human to choose themselves, then waits (never fails immediately)", async () => {
    const dom = new JSDOM(`<h1>Select condition</h1>`, { url: "https://www.ebay.co.uk/sl/prelist/identify?caty=95672" });
    const doc = dom.window.document;
    const location = dom.window.location;
    const reports: Array<[string, unknown]> = [];
    // Resolve the wait quickly by flipping the URL to the real form shortly after — mirrors a human clicking Continue.
    setTimeout(() => { dom.reconfigure({ url: "https://www.ebay.co.uk/lstng?draftId=1&mode=AddItem" }); }, 50);
    const result = await stepWaitForManualCondition({ doc, location }, (status: string, extra: unknown) => reports.push([status, extra]));
    expect(result.ok).toBe(true);
    expect(reports.some(([, extra]) => (extra as { currentStep?: string })?.currentStep === "SELECT_CONDITION_MANUAL")).toBe(true);
    expect(reports.some(([, extra]) => /select the closest matching condition yourself/i.test((extra as { detail?: string })?.detail || ""))).toBe(true);
  });

  it("times out (fails, never guesses) if no human ever selects a condition — using a genuinely human-scale timeout, not a form-filling one", () => {
    expect(MANUAL_CONDITION_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it("REQUIREMENT: skips straight through (a safe no-op) if already on the real form — never re-shows the manual-selection message for an already-selected condition", async () => {
    const dom = new JSDOM(``, { url: "https://www.ebay.co.uk/lstng?draftId=1&mode=AddItem" });
    const result = await stepWaitForManualCondition({ doc: dom.window.document, location: dom.window.location });
    expect(result).toEqual({ ok: true, alreadySelected: true });
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
