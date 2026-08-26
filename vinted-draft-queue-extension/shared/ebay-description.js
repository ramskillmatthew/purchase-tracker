const BLOCK_END = /<\/(?:address|article|aside|blockquote|div|h[1-6]|li|ol|p|pre|section|table|tr|ul)>/gi;

export function isAllowedEbayDescriptionUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "ebaydesc.com" || url.hostname.endsWith(".ebaydesc.com"));
  } catch { return false; }
}

// A deliberately small, fixed set — the seller-description iframe is plain
// prose/HTML, not a place arbitrary named entities need supporting. Covers
// the reported bug (amp) plus the other entities real seller-written
// descriptions commonly contain (curly quotes/dashes from a pasted Word
// document, currency/legal symbols, ellipses).
const NAMED_ENTITIES = {
  amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
  copy: "©", reg: "®", trade: "™",
  pound: "£", euro: "€", cent: "¢", yen: "¥",
  hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  deg: "°", middot: "·", bull: "•",
  times: "×", divide: "÷", sect: "§", para: "¶",
  frac12: "½", frac14: "¼", frac34: "¾",
};
const NAMED_ENTITY_PATTERN = Object.keys(NAMED_ENTITIES).join("|");

function decodeEntities(value) {
  return value.replace(new RegExp(`&(#x[\\da-f]+|#\\d+|${NAMED_ENTITY_PATTERN});`, "gi"), (match, entity) => {
    if (entity[0] !== "#") return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

export function htmlToPlainText(html) {
  if (typeof html !== "string") return "";
  return decodeEntities(html
    .replace(/<(?:script|style|noscript|head)[^>]*>[\s\S]*?<\/(?:script|style|noscript|head)>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(BLOCK_END, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\r/g, "").replace(/[\t ]+\n/g, "\n").replace(/\n[\t ]+/g, "\n")
    .replace(/[\t ]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
