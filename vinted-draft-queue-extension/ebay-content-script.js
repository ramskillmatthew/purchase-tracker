// eBay UK listing reader. This module only reads the current item page and
// returns structured data to the extension service worker; it never clicks a
// buy, sell, revise, or publish control.

const MAX_IMAGES = 24;

function cleanText(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text || null;
}

function itemIdFromUrl(value) {
  return value.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,15})(?:[/?#]|$)/i)?.[1] ?? null;
}

function findProduct(value) {
  if (Array.isArray(value)) {
    for (const child of value) { const result = findProduct(child); if (result) return result; }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const type = value["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return value;
  for (const key of ["@graph", "mainEntity", "itemListElement"]) {
    const result = findProduct(value[key]);
    if (result) return result;
  }
  return null;
}

function readJsonLdProduct() {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { const product = findProduct(JSON.parse(script.textContent || "null")); if (product) return product; }
    catch { /* Ignore malformed third-party JSON-LD. */ }
  }
  return {};
}

function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return strings(value.url ?? value.contentUrl ?? value.image);
  return [];
}

function readSpecifics(product) {
  const specifics = {};
  for (const property of Array.isArray(product.additionalProperty) ? product.additionalProperty : []) {
    const name = cleanText(property?.name);
    const value = cleanText(property?.value);
    if (name && value) specifics[name] = value;
  }

  // Current eBay pages render item specifics as definition lists. This is a
  // fallback for listings whose JSON-LD omits additionalProperty.
  for (const term of document.querySelectorAll("dl dt, .ux-labels-values__labels")) {
    const name = cleanText(term.textContent);
    const valueNode = term.matches("dt") ? term.nextElementSibling : term.parentElement?.querySelector(".ux-labels-values__values");
    const value = cleanText(valueNode?.textContent);
    if (name && value && !specifics[name]) specifics[name] = value;
  }
  return specifics;
}

function specific(specifics, names) {
  const wanted = names.map(name => name.toLowerCase());
  for (const [key, value] of Object.entries(specifics)) if (wanted.includes(key.toLowerCase())) return value;
  return null;
}

function meta(property) {
  return cleanText(document.querySelector(`meta[property="${property}"], meta[name="${property}"]`)?.content);
}

function readListing() {
  const itemId = itemIdFromUrl(location.href);
  if (!itemId) throw new Error("Open an eBay UK item listing before importing.");
  if (/captcha|verify you are human|pardon our interruption/i.test(document.body?.innerText || "")) {
    throw new Error("Complete eBay's security check, then retry this listing.");
  }

  const product = readJsonLdProduct();
  const offers = product.offers && typeof product.offers === "object" ? product.offers : {};
  const specifics = readSpecifics(product);
  const title = cleanText(product.name) ?? meta("og:title") ?? cleanText(document.querySelector("h1")?.textContent);
  if (!title) throw new Error("The listing title could not be read.");
  const description = cleanText(product.description) ?? meta("og:description") ?? "";
  const images = [...new Set([
    ...strings(product.image),
    ...[...document.querySelectorAll('img[src*="ebayimg.com"]')].map(image => image.currentSrc || image.src),
    meta("og:image") ?? "",
  ].filter(url => /^https:\/\//i.test(url)).map(url => url.replace(/s-l\d+\./i, "s-l1600.")))].slice(0, MAX_IMAGES);
  if (!images.length) throw new Error("No listing photos could be read.");
  const price = Number(offers.price ?? meta("og:price:amount"));
  const colour = specific(specifics, ["Colour", "Color"]);

  return {
    itemId,
    url: `https://www.ebay.co.uk/itm/${itemId}`,
    title,
    description,
    imageUrls: images,
    pricePence: Number.isFinite(price) ? Math.round(price * 100) : null,
    currency: cleanText(offers.priceCurrency) ?? meta("og:price:currency"),
    condition: cleanText(product.itemCondition) ?? specific(specifics, ["Condition"]),
    category: cleanText(product.category),
    brand: cleanText(product.brand?.name ?? product.brand) ?? specific(specifics, ["Brand"]),
    size: specific(specifics, ["UK Shoe Size", "Shoe Size", "Size"]),
    colours: colour ? colour.split(/\s*(?:,|&|\/| and )\s*/i).filter(Boolean).slice(0, 2) : [],
    material: specific(specifics, ["Upper Material", "Material"]),
    quantity: Number.isFinite(Number(offers.inventoryLevel)) ? Number(offers.inventoryLevel) : null,
    itemSpecifics: specifics,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "EBAY_READ_LISTING") return false;
  try { sendResponse({ ok: true, listing: readListing() }); }
  catch (error) { sendResponse({ ok: false, error: error?.message || "This eBay listing could not be read." }); }
  return false;
});

