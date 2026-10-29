(() => {
  const clean = value => typeof value === "string" ? value.trim() : value;
  const meta = name => document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content?.trim() || "";
  const first = (...values) => values.find(value => value !== undefined && value !== null && String(value).trim() !== "") ?? "";
  const pathValue = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
  const fromPaths = (object, paths) => first(...paths.map(path => pathValue(object, path)));
  const imageUrl = photo => typeof photo === "string" ? photo : first(photo?.full_size_url, photo?.url, photo?.image_url, photo?.src);

  function structuredObjects() {
    const roots = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"],script[type="application/json"],script#__NEXT_DATA__')) {
      if (!script.textContent || script.textContent.length > 6000000) continue;
      try { roots.push(JSON.parse(script.textContent)); } catch { /* Ignore unrelated non-JSON scripts. */ }
    }
    const objects = [], queue = [...roots], seen = new Set();
    while (queue.length && objects.length < 60000) {
      const value = queue.shift();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value); objects.push(value);
      if (Array.isArray(value)) queue.push(...value);
      else queue.push(...Object.values(value));
    }
    return objects;
  }

  function scoreCandidate(object) {
    let score = 0;
    if (first(object.title, object.name)) score += 2;
    if (first(object.size_title, object.size?.title, object.size)) score += 4;
    if (first(object.price?.amount, object.price?.numeric_amount, object.price, object.offers?.price)) score += 2;
    if (first(object.user?.login, object.seller?.name, object.seller_name)) score += 2;
    if (first(object.photos, object.images, object.image)) score += 1;
    if (first(object.id, object.item_id)) score += 1;
    return score;
  }

  const normalText = value => String(value || "").replace(/\s+/g, " ").trim();
  function domField(label) {
    const wanted = label.toLowerCase();
    const elements = [...document.querySelectorAll("body *")].filter(element => normalText(element.innerText || element.textContent).toLowerCase() === wanted);
    for (const element of elements) {
      const siblings = [...(element.parentElement?.children || [])];
      const siblingIndex = siblings.indexOf(element);
      for (const sibling of siblings.slice(siblingIndex + 1)) {
        const value = normalText(sibling.innerText || sibling.textContent);
        if (value && value.toLowerCase() !== wanted && value.length < 120) return value;
      }
      let container = element.parentElement;
      for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
        const lines = (container.innerText || "").split(/\n+/).map(line => line.trim()).filter(Boolean);
        const index = lines.findIndex(line => normalText(line).toLowerCase() === wanted);
        if (index >= 0 && lines[index + 1] && lines[index + 1].length < 120) return lines[index + 1];
      }
    }
    return "";
  }

  function summarySize() {
    const heading = document.querySelector("h1");
    if (!heading) return "";
    let container = heading.parentElement;
    for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
      const lines = (container.innerText || "").split(/\n+/).map(normalText).filter(Boolean);
      const titleIndex = lines.findIndex(line => line === normalText(heading.innerText || heading.textContent));
      const summary = lines[titleIndex + 1] || "";
      const value = summary.match(/^((?:EU|UK)?\s*\d+(?:[.,]\d+)?)\s*[·|]/i)?.[1];
      if (value) return value.replace(",", ".");
    }
    return "";
  }

  function extractListing() {
    const objects = structuredObjects();
    const candidate = objects.sort((a, b) => scoreCandidate(b) - scoreCandidate(a))[0] || {};
    const product = objects.find(object => object?.["@type"] === "Product") || {};
    const photos = first(candidate.photos, candidate.images, candidate.image, product.image, []);
    const rawImages = Array.isArray(photos) ? photos : [photos];
    const images = [...new Set([meta("og:image"), ...rawImages.map(imageUrl)].filter(Boolean))].slice(0, 12);
    const itemId = location.pathname.match(/\/items\/(\d+)/)?.[1] || String(first(candidate.id, candidate.item_id, ""));
    const structuredSize = clean(first(candidate.size_title, candidate.size?.title, typeof candidate.size === "string" ? candidate.size : ""));
    const detailSize = clean(domField("Size"));
    const headerSize = clean(summarySize());
    return {
      itemId,
      url: location.href,
      canonicalUrl: document.querySelector('link[rel="canonical"]')?.href || location.href,
      title: clean(first(candidate.title, candidate.name, product.name, document.querySelector("h1")?.innerText, meta("og:title"), document.title)),
      description: clean(first(candidate.description, product.description, meta("og:description"))),
      price: clean(fromPaths(candidate, ["price.amount", "price.numeric_amount", "price", "offers.price"]) || fromPaths(product, ["offers.price"])),
      currency: clean(first(candidate.currency, candidate.price?.currency_code, candidate.offers?.priceCurrency, product.offers?.priceCurrency, "GBP")),
      size: clean(first(structuredSize, detailSize, headerSize)),
      sizeSource: structuredSize ? "structured-data" : detailSize ? "details-row" : headerSize ? "header-summary" : "not-found",
      condition: clean(first(candidate.status_title, candidate.condition, product.itemCondition, domField("Condition"))),
      brand: clean(first(candidate.brand_title, candidate.brand?.title, candidate.brand?.name, product.brand?.name, product.brand, domField("Brand"))),
      seller: clean(first(candidate.user?.login, candidate.seller?.login, candidate.seller?.name, candidate.seller_name, domField("Member"), domField("Seller"))),
      sellerRating: clean(first(candidate.user?.feedback_reputation, candidate.seller?.rating, candidate.seller_rating)),
      images,
      extractedAt: Date.now(),
      source: scoreCandidate(candidate) >= 4 ? "structured-data" : "page-fallback"
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "SOURCING_EXTRACT_VINTED_LISTING") {
      const listing = extractListing();
      respond({ ok: true, ready: Boolean(listing.title && listing.size), listing });
    }
  });
})();
