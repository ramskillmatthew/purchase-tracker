(() => {
  const normalize = value => String(value || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
  const classify = value => {
    const text = normalize(value);
    const success = text.includes("item reserved payment needed") && text.includes("reserved for you") && text.includes("complete payment");
    return success ? "success" : "failed";
  };
  const field = (text, start, end) => {
    const source = String(text || "").replace(/\s+/g, " ").trim();
    const pattern = new RegExp(`(?:^|\\s)${start}\\s+(.+?)\\s+${end}(?:\\s|$)`, "i");
    return source.match(pattern)?.[1]?.trim() || "";
  };
  const extract = (text, links = []) => {
    const source = String(text || "").replace(/\s+/g, " ").trim();
    const findLink = name => links.find(link => normalize(link.label) === name)?.url || "";
    return {
      outcome: classify(source),
      price: source.match(/(?:^|\s)Price\s+([0-9]+(?:[.,][0-9]+)?)\s*GBP(?:\s|$)/i)?.[1]?.replace(",", ".") || "",
      seller: field(source, "Seller", "Item"),
      item: source.match(/(?:^|\s)Seller\s+.+?\s+Item\s+(.+?)\s+Size(?:\s|$)/i)?.[1]?.trim() || "",
      size: field(source, "Size", "Brand"),
      brand: field(source, "Brand", "Description"),
      description: field(source, "Description", "Links"),
      itemUrl: findLink("view item"),
      purchaseUrl: findLink("view purchase")
    };
  };
  globalThis.SourcingInboxRules = Object.freeze({ normalize, classify, extract });
})();
