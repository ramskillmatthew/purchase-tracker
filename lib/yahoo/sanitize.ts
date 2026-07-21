import sanitizeHtml from "sanitize-html";

const safeOptions: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "div", "span", "strong", "b", "em", "i", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "a", "h1", "h2", "h3", "h4"],
  allowedAttributes: { a: ["href", "title", "rel", "target"] }, allowedSchemes: ["http", "https", "mailto"], allowProtocolRelative: false,
  transformTags: { a: (_tag, attrs) => ({ tagName: "a", attribs: { ...attrs, rel: "noreferrer noopener", target: "_blank" } }) },
  disallowedTagsMode: "discard",
};
export function sanitizeEmailHtml(html: string) { return sanitizeHtml(html, safeOptions); }
export function emailText(htmlOrText: string) {
  return sanitizeHtml(htmlOrText, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
}
export function excerpt(value: string, length = 280) { const text = emailText(value); return text.length > length ? `${text.slice(0, length).trim()}…` : text; }
