import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const context = { globalThis: {} };
vm.runInNewContext(readFileSync(path.join(dir, "..", "shared", "inbox-rules.js"), "utf8"), context);
const { classify, extract } = context.globalThis.SourcingInboxRules;

assert.equal(classify("Item Reserved - Payment Needed\nThe item has been reserved for you!\nCLICK HERE TO COMPLETE PAYMENT"), "success");
assert.equal(classify("Failed to handle last request: checkout_error"), "failed");
assert.equal(classify("This item could not be reserved for you"), "failed");
assert.equal(classify("Payment error. Please use another payment method."), "failed");
const extracted = extract("Item Reserved - Payment Needed The item has been reserved for you! CLICK HERE TO COMPLETE PAYMENT Price 9.0 GBP Delivery Type Home Delivery Seller dancingq1 Item Nike Air Force Size 38 Brand Nike Description Used but good condition. Need a wipe. Links View Item View Purchase", [
  { label: "View Item", url: "https://www.vinted.co.uk/items/123" },
  { label: "View Purchase", url: "https://www.vinted.co.uk/transactions/456" }
]);
assert.deepEqual(JSON.parse(JSON.stringify(extracted)), { outcome: "success", price: "9.0", seller: "dancingq1", item: "Nike Air Force", size: "38", brand: "Nike", description: "Used but good condition. Need a wipe.", itemUrl: "https://www.vinted.co.uk/items/123", purchaseUrl: "https://www.vinted.co.uk/transactions/456" });
console.log("All inbox classification tests passed.");
