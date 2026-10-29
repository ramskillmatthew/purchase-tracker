import assert from "node:assert/strict";
import { JSDOM } from "../../node_modules/jsdom/lib/api.js";
import { accessibleLabel, buyNowButtonsInside, discordMessageKey, isExactBuyNowButton, normaliseActionWords } from "../shared/detection.js";

const dom=new JSDOM(`<li id="chat-messages-1"><button>💸 Buy Now</button><button>Buy now please</button><a role="button" aria-label="💸 Buy Now"></a></li>`);
const [exact,near,aria]=dom.window.document.querySelectorAll("button,a");
assert.equal(accessibleLabel(exact),"💸 buy now");
assert.equal(normaliseActionWords(exact.textContent),"buy now");
assert.equal(isExactBuyNowButton(exact),true);
assert.equal(isExactBuyNowButton(near),false);
assert.equal(isExactBuyNowButton(aria),true);
assert.equal(buyNowButtonsInside(dom.window.document.querySelector("li")).length,2);
assert.equal(discordMessageKey(exact.closest("li"),exact),"chat-messages-1");
console.log("All sourcing detector tests passed.");
