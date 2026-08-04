import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("components/AppHeader.tsx — Milestone 5: Listings Review navigation", () => {
  const source = read("components/AppHeader.tsx");

  it("adds a 'Listings Review' link to /listings-review with a dedicated icon, right after Listing Studio, without removing/renaming any existing link", () => {
    expect(source).toContain('{ label: "Listings Review", href: "/listings-review", icon: "review" }');
    for (const label of ["Home", "Tasks", "Purchases", "Listing Studio", "Bulk Input", "Email Assistant", "Purchase Import", "Expenses", "Export", "Settings"]) {
      expect(source).toContain(`label: "${label}"`);
    }
  });

  it("defines a distinct 'review' icon (not reusing another icon's path)", () => {
    expect(source).toMatch(/review:\s*<>/);
  });
});

describe("app/listings-review/page.tsx — Milestone 5: dedicated review page", () => {
  const source = read("app/listings-review/page.tsx");

  it("renders ListingsReviewWorkspace as the page's own content, not a tab/view inside Listing Studio", () => {
    expect(source).toContain("import ListingsReviewWorkspace from \"@/components/listings-review/ListingsReviewWorkspace\";");
    expect(source).toContain("<ListingsReviewWorkspace />");
  });

  it("has its own page heading distinct from Listing Studio's", () => {
    expect(source).toContain("<h1>Listings Review</h1>");
  });
});

describe("components/listings-review/ListingsReviewWorkspace.tsx — Milestone 5: orchestration, reuse, performance", () => {
  const source = read("components/listings-review/ListingsReviewWorkspace.tsx");

  it("fetches from the dedicated read-only listings-review endpoint, never the Listing Studio workspace endpoint", () => {
    expect(source).toContain('fetch("/api/listing-studio/listings-review")');
    expect(source).not.toContain('fetch("/api/listing-studio/workspace")');
  });

  describe("Search", () => {
    it("wires the search box's value/onChange straight through to matchesListingSearch via the memoized filteredRows", () => {
      expect(source).toContain("const [searchQuery, setSearchQuery] = useState(\"\");");
      expect(source).toContain("matchesListingSearch({ generatedTitle: row.generatedTitle, sku: row.sku, brand: row.brand, model: row.model, colours: row.colours }, searchQuery)");
    });
  });

  describe("Filters", () => {
    it("has an 'all' | status three-way filter plus a multi-select quick-filter Set, both feeding the same filteredRows computation", () => {
      expect(source).toContain('const [statusFilter, setStatusFilter] = useState<ListingReviewStatusFilter>("all");');
      expect(source).toContain("const [activeQuickFilters, setActiveQuickFilters] = useState<Set<ListingQuickFilter>>(new Set());");
      expect(source).toContain('if (statusFilter !== "all" && row.status !== statusFilter) return false;');
      expect(source).toContain("for (const filter of activeQuickFilters) if (!matchesQuickFilter(row, filter)) return false;");
    });

    it("toggleQuickFilter adds/removes from the Set immutably (a fresh Set each time, never mutating the current one in place)", () => {
      const fnIndex = source.indexOf("const toggleQuickFilter = useCallback");
      const fnBlock = source.slice(fnIndex, source.indexOf("}, []);", fnIndex));
      expect(fnBlock).toContain("const next = new Set(current);");
      expect(fnBlock).toContain("if (next.has(filter)) next.delete(filter); else next.add(filter);");
    });
  });

  describe("Status changes / Ready-Needs Review-Edited rules", () => {
    it("computes status/warnings once per listing via the shared pure lib, never re-implementing the rule inline", () => {
      expect(source).toContain("status: computeListingReviewStatus(reviewable),");
      expect(source).toContain("warnings: buildListingWarnings(reviewable),");
    });

    it("Mark Ready posts to the dedicated mark-ready route and patches only review_marked_ready_at locally", () => {
      expect(source).toContain("fetch(`/api/listing-studio/groups/${listingId}/mark-ready`, { method: \"POST\" });");
      expect(source).toContain("review_marked_ready_at: body.reviewMarkedReadyAt");
    });
  });

  describe("Bulk selection", () => {
    it("maintains a bulk-selected id Set independent of the single selectedListingId used for the detail panel", () => {
      expect(source).toContain("const [selectedListingId, setSelectedListingId] = useState<string | null>(null);");
      expect(source).toContain("const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());");
    });

    it("REGRESSION: select-all only ever affects the currently VISIBLE (filtered) rows, never every listing regardless of filters", () => {
      const fnIndex = source.indexOf("const toggleSelectAll = useCallback");
      const fnBlock = source.slice(fnIndex, source.indexOf("}, [filteredRows]);", fnIndex));
      expect(fnBlock).toContain("const visibleIds = filteredRows.map(row => row.id);");
    });

    it("bulk mark-ready and bulk delete both run with a concurrency limit, one request per selected listing, continuing past individual failures", () => {
      expect(source).toContain("await runWithConcurrencyLimit(ids, 5, async id => {");
      const deleteBlock = source.slice(source.indexOf("async function commitDelete"), source.indexOf("function handleBulkDelete"));
      expect(deleteBlock).toContain("failureCount += 1");
    });

    it("Milestone 6: bulk mark-ready groups skip reasons (the route's own per-listing error message) into a useful summary, never just a blind failure count", () => {
      const bulkMarkReadyBlock = source.slice(source.indexOf("async function handleBulkMarkReady"), source.indexOf("async function commitDelete"));
      expect(bulkMarkReadyBlock).toContain("skipReasonCounts.set(reason, (skipReasonCounts.get(reason) ?? 0) + 1);");
      expect(bulkMarkReadyBlock).toContain("succeededCount += 1;");
    });

    it("Follow-up correction (closing the Mark Ready readiness gap): the bulk summary tallies each individual missing-field reason from the route's `warnings` array, not just the whole joined error string — so 'Missing SKU (3), No uploaded photos (2)' is possible instead of one bucket per unique combination", () => {
      const bulkMarkReadyBlock = source.slice(source.indexOf("async function handleBulkMarkReady"), source.indexOf("async function commitDelete"));
      expect(bulkMarkReadyBlock).toContain("Array.isArray(body.warnings)");
      expect(bulkMarkReadyBlock).toContain("for (const reason of reasons)");
    });

    it("bulk delete reuses the EXISTING single-group DELETE route with mode 'delete_photos' — never a new bulk-delete endpoint", () => {
      expect(source).toContain('method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "delete_photos" }),');
    });

    it("Export and List automatically exist only as disabled placeholders — no handler, no endpoint, just a 'coming' tooltip", () => {
      expect(source).toContain('<button type="button" className="button-secondary" disabled title="Coming in a future milestone">Export</button>');
      expect(source).toContain('<button type="button" className="button-secondary" disabled title="Coming in a future milestone">List automatically</button>');
    });

    it("a successful bulk delete clears the deleted ids from both the bulk selection and, if it was open, the detail panel selection", () => {
      const fnBlock = source.slice(source.indexOf("async function commitDelete"), source.indexOf("function handleBulkDelete"));
      expect(fnBlock).toContain("setBulkSelectedIds(current => { const next = new Set(current); for (const id of ids) next.delete(id); return next; });");
      expect(fnBlock).toContain("setSelectedListingId(current => (ids.includes(current ?? \"\") ? null : current));");
    });
  });

  describe("Preview integration", () => {
    it("reuses PreviewListingDialog (imported from Listing Studio, not duplicated) and passes the real cover photo URL + condition", () => {
      expect(source).toContain('import PreviewListingDialog from "@/components/listing-studio/PreviewListingDialog";');
      expect(source).toContain("condition={previewListing.condition}");
      expect(source).toContain("coverImageUrl={previewListing.coverPhotoId ? `/api/listing-studio/images/${previewListing.coverPhotoId}/view` : null}");
    });
  });

  describe("Edit Fields integration", () => {
    it("reuses EditListingFieldsDialog (imported from Listing Studio, not duplicated) and calls the SAME /fields PATCH route Listing Studio uses", () => {
      expect(source).toContain('import EditListingFieldsDialog, { type ListingFieldsDraft } from "@/components/listing-studio/EditListingFieldsDialog";');
      expect(source).toContain("fetch(`/api/listing-studio/groups/${listingId}/fields`, {");
      expect(source).toContain('method: "PATCH", headers: { "Content-Type": "application/json" },');
    });

    it("REGRESSION: never accepts or sends a title/description directly — only the structured fields, exactly like Listing Studio's own Edit Fields wiring", () => {
      const fnBlock = source.slice(source.indexOf("async function handleSaveListingFields"), source.indexOf("async function handleSaveListingFields") + 900);
      expect(fnBlock).not.toContain("title:");
      expect(fnBlock).not.toContain("description:");
      expect(fnBlock).toContain("brand: fields.brand || null, model: fields.model || null, productType: fields.productType || null,");
    });
  });

  describe("Warnings", () => {
    it("warnings are recomputed as part of listingRows, which is recomputed whenever the underlying drafts/images change (e.g. after an edit) — never stale", () => {
      expect(source).toContain("}), [drafts, photoIdsByDraftId]);");
    });
  });

  describe("Photo carousel wiring", () => {
    it("opens the carousel for the listing's own full photo list, sourced from the same per-draft photo grouping as the cover photo", () => {
      expect(source).toContain("photos={carouselListing.photoIds.map(id => ({ id }))}");
    });
  });

  describe("Performance-sensitive rendering", () => {
    it("derives photo grouping, listing rows, the id lookup map, and the filtered/search result all via useMemo — never recomputed from scratch on every render", () => {
      expect(source).toContain("const photoIdsByDraftId = useMemo(() => {");
      expect(source).toContain("const listingRows: ListingRow[] = useMemo(() => drafts.map(draft => {");
      expect(source).toContain("const listingsById = useMemo(() => new Map(listingRows.map(row => [row.id, row])), [listingRows]);");
      expect(source).toContain("const filteredRows = useMemo(() => listingRows.filter(row => {");
    });

    it("every handler passed down to a memoized child is itself useCallback'd (toggleQuickFilter, toggleBulkSelect, toggleSelectAll, openCarousel), so those children's memo() actually prevents unrelated re-renders", () => {
      for (const fn of ["toggleQuickFilter", "toggleBulkSelect", "toggleSelectAll", "openCarousel"]) {
        expect(source).toContain(`const ${fn} = useCallback(`);
      }
    });

    it("REGRESSION: status/warnings/cover-photo/photo-list are computed exactly once per listing inside the listingRows useMemo, not inside ListingsTable or ListingDetailsPanel's own render", () => {
      const tableSource = read("components/listings-review/ListingsTable.tsx");
      const panelSource = read("components/listings-review/ListingDetailsPanel.tsx");
      expect(tableSource).not.toContain("computeListingReviewStatus");
      expect(tableSource).not.toContain("buildListingWarnings");
      expect(panelSource).not.toContain("computeListingReviewStatus");
      expect(panelSource).not.toContain("buildListingWarnings");
    });
  });
});

describe("components/listings-review/ListingsTable.tsx — Milestone 5: left table", () => {
  const source = read("components/listings-review/ListingsTable.tsx");

  it("is memo()'d", () => {
    expect(source).toContain("export default memo(ListingsTable);");
  });

  it("has exactly the required columns: Cover Photo, Generated Title, Brand, UK Size, SKU, Status (plus the bulk-select checkbox column)", () => {
    for (const column of ["Cover photo", "Generated title", "Brand", "UK size", "SKU", "Status"]) {
      expect(source).toContain(`<th>${column}</th>`);
    }
  });

  it("REGRESSION: clicking the row-select checkbox stops propagation so it never also triggers the row's own onSelectListing click", () => {
    expect(source).toContain('<td className="listings-review-checkbox-cell" onClick={event => event.stopPropagation()}>');
  });

  it("clicking anywhere else on the row selects it into the detail panel", () => {
    expect(source).toContain("onClick={() => onSelectListing(row.id)}");
  });

  it("highlights the currently selected row with a distinct class", () => {
    expect(source).toContain('className={row.id === selectedListingId ? "listings-review-row listings-review-row-active" : "listings-review-row"}');
  });

  it("shows an empty state when the filtered row list is empty, rather than an empty table body", () => {
    expect(source).toContain("rows.length === 0");
    expect(source).toContain("No listings match.");
  });
});

describe("components/listings-review/ListingDetailsPanel.tsx — Milestone 5: persistent right panel", () => {
  const source = read("components/listings-review/ListingDetailsPanel.tsx");

  it("is memo()'d and shows a placeholder when nothing is selected, rather than being unmounted/hidden entirely", () => {
    expect(source).toContain("export default memo(ListingDetailsPanel);");
    expect(source).toContain("listings-review-panel-empty");
  });

  it("displays every required field: large cover image, generated title, generated description, brand, model, product type, colour(s), material, UK size, SKU, condition", () => {
    expect(source).toContain('className="listings-review-panel-image"');
    expect(source).toContain('className="listings-review-panel-title"');
    expect(source).toContain('className="listings-review-panel-description"');
    for (const field of ["Brand", "Model", "Product type", "Material", "UK size", "SKU", "Condition"]) {
      expect(source).toContain(`<dt>${field}</dt>`);
    }
  });

  it("Milestone 6 (Vinted-aware colours/materials): shows both colours when two exist, joined the same way the title does, and the colour dt pluralises to 'Colours' when there are two", () => {
    expect(source).toContain('<div><dt>Colour{listing.colours.length > 1 ? "s" : ""}</dt><dd>{listing.colours.length > 0 ? listing.colours.join(" & ") : "Not set"}</dd></div>');
  });

  it("REGRESSION: never shows an AI confidence value anywhere — warnings replace it entirely", () => {
    expect(source).not.toMatch(/confidence/i);
  });

  it("has exactly the three required buttons: Preview Listing, Edit Fields, Mark Ready", () => {
    expect(source).toContain(">Preview listing<");
    expect(source).toContain(">Edit fields<");
    expect(source).toMatch(/>Mark ready<|Marking ready…/);
  });

  it("REGRESSION: Mark Ready is only ever actionable on an Edited listing — disabled for Ready (nothing to do) and Needs Review (missing fields always win, no override)", () => {
    expect(source).toContain('disabled={markingReady || listing.status !== "edited"}');
  });

  it("clicking the cover image opens the photo carousel for this listing, and is disabled when there's no photo at all", () => {
    expect(source).toContain("onClick={() => onOpenCarousel(listing.id)}");
    expect(source).toContain("disabled={!listing.coverPhotoId}");
  });

  it("renders one warning per entry from the listing's own warnings array — nothing hardcoded", () => {
    expect(source).toContain("{listing.warnings.map(warning => <li key={warning}");
  });
});

describe("components/listings-review/ListingsFilterBar.tsx — Milestone 5: search + status tabs + quick filters", () => {
  const source = read("components/listings-review/ListingsFilterBar.tsx");

  it("is memo()'d", () => {
    expect(source).toContain("export default memo(ListingsFilterBar);");
  });

  it("has exactly the required status tabs: All, Ready, Needs review, Edited", () => {
    expect(source).toContain('{ value: "all", label: "All" }');
    expect(source).toContain('{ value: "ready", label: "Ready" }');
    expect(source).toContain('{ value: "needs_review", label: "Needs review" }');
    expect(source).toContain('{ value: "edited", label: "Edited" }');
  });

  it("has exactly the required quick filters: Missing SKU, Missing size, Missing brand, Missing colour — no Missing Model quick filter", () => {
    expect(source).toContain('{ value: "missing_sku", label: "Missing SKU" }');
    expect(source).toContain('{ value: "missing_size", label: "Missing size" }');
    expect(source).toContain('{ value: "missing_brand", label: "Missing brand" }');
    expect(source).toContain('{ value: "missing_colour", label: "Missing colour" }');
    expect(source).not.toContain("Missing model");
  });

  it("the search input is wired directly to onSearchQueryChange — instant, no debounce/delay", () => {
    expect(source).toContain("onChange={event => onSearchQueryChange(event.target.value)}");
    expect(source).not.toMatch(/setTimeout|debounce/);
  });
});

describe("components/listings-review/PhotoCarouselDialog.tsx — Milestone 5: simple lightbox + thumbnail strip", () => {
  const source = read("components/listings-review/PhotoCarouselDialog.tsx");

  it("shows one large main photo plus a horizontal thumbnail strip for every photo in this listing", () => {
    expect(source).toContain('className="photo-carousel-main-image"');
    expect(source).toContain('className="photo-carousel-thumbnail-strip"');
    expect(source).toContain("{photos.map(photo =>");
  });

  it("highlights the currently active thumbnail with a distinct class and aria-selected", () => {
    expect(source).toContain('className={photo.id === activePhotoId ? "photo-carousel-thumbnail photo-carousel-thumbnail-active" : "photo-carousel-thumbnail"}');
    expect(source).toContain("aria-selected={photo.id === activePhotoId}");
  });

  it("clicking a thumbnail switches the main photo instantly (local state, no network round-trip)", () => {
    expect(source).toContain("onClick={() => setActivePhotoId(photo.id)}");
  });

  it("both the main image and every thumbnail load via the existing per-image signed view endpoint", () => {
    const matches = source.match(/\/api\/listing-studio\/images\/\$\{[^}]+\}\/view/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("Escape closes the dialog; arrow keys navigate between photos", () => {
    expect(source).toContain('if (event.key === "Escape") { onClose(); return; }');
    expect(source).toMatch(/ArrowRight/);
    expect(source).toMatch(/ArrowLeft/);
  });

  it("renders nothing when there are no photos, rather than an empty/broken lightbox", () => {
    expect(source).toContain("if (!photos.length || !activePhotoId) return null;");
  });
});

describe("components/listing-studio/PreviewListingDialog.tsx — Milestone 5: extended with a Vinted-style card, not duplicated", () => {
  const source = read("components/listing-studio/PreviewListingDialog.tsx");

  it("condition and coverImageUrl are optional props, so Listing Studio's existing call site (which passes neither) keeps compiling unchanged", () => {
    expect(source).toContain("condition?: string | null;");
    expect(source).toContain("coverImageUrl?: string | null;");
    expect(source).toContain("condition = null, coverImageUrl = null,");
  });

  it("shows condition and size directly from props", () => {
    expect(source).toContain("<dt>Condition</dt><dd>{condition || \"Not set\"}</dd>");
    expect(source).toContain("<dt>Size</dt><dd>{ukSize ? `UK ${ukSize}` : \"Not set\"}</dd>");
  });

  it("Milestone 6: shows the real saved selling price when set, the explicit placeholder only when it isn't — sellingPricePence defaults to null so Listing Studio's own call site (which has none) still shows the placeholder unchanged", () => {
    expect(source).toContain("sellingPricePence = null,");
    expect(source).toContain('<dd className={sellingPricePence ? undefined : "preview-listing-vinted-price-placeholder"}>{sellingPricePence ? formatPenceAsGBP(sellingPricePence) : "Price not set"}</dd>');
  });

  it("shows a large cover image when provided, and a distinct empty state when not", () => {
    expect(source).toContain('<img className="preview-listing-vinted-image" src={coverImageUrl} alt="" />');
    expect(source).toContain('className="preview-listing-vinted-image preview-listing-vinted-image-empty"');
  });

  it("REGRESSION: still has no input/textarea/onChange anywhere — the new Vinted card is just as read-only as the rest of this dialog", () => {
    expect(source).not.toMatch(/<input\b|<textarea\b|onChange/);
  });
});

describe("app/globals.css — Milestone 5: Listings Review styling exists for every new component", () => {
  const css = read("app/globals.css");

  it("styles the split layout, table, status badges, panel, warnings, carousel, and the extended preview card", () => {
    for (const selector of [
      ".listings-review-split", ".listings-review-table", ".listings-review-status-badge",
      ".listings-review-panel", ".listings-review-warning", ".photo-carousel-thumbnail-strip",
      ".preview-listing-vinted-card",
    ]) {
      expect(css).toContain(selector);
    }
  });

  it("gives each of the three statuses a visually distinct colour (not all sharing one style)", () => {
    expect(css).toMatch(/\.listings-review-status-ready\s*\{[^}]*color:\s*#16845d/);
    expect(css).toMatch(/\.listings-review-status-needs_review\s*\{[^}]*color:\s*var\(--danger\)/);
    expect(css).toMatch(/\.listings-review-status-edited\s*\{[^}]*color:\s*#b4740e/);
  });

  it("Milestone 6: styles the purchase-price section and the selling-price control", () => {
    for (const selector of [".listings-review-panel-purchase-section", ".listings-review-panel-purchase-line", ".listings-review-selling-price-row", ".listings-review-selling-price-status"]) {
      expect(css).toContain(selector);
    }
  });
});

describe("Milestone 6 (purchase-price lookup and manual Vinted selling price) — UI wiring", () => {
  const filterBarSource = read("components/listings-review/ListingsFilterBar.tsx");
  const panelSource = read("components/listings-review/ListingDetailsPanel.tsx");
  const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");
  const fieldSource = read("components/listings-review/SellingPriceField.tsx");

  it("adds a 'Missing price' quick filter alongside the existing ones", () => {
    expect(filterBarSource).toContain('{ value: "missing_price", label: "Missing price" }');
  });

  it("the details panel renders the purchase-match line and the selling-price field close to SKU, never inside the Edit Fields dialog", () => {
    expect(panelSource).toContain("describePurchaseMatch(listing.purchaseMatch)");
    expect(panelSource).toContain("<SellingPriceField");
    expect(panelSource).toContain("key={listing.id}");
  });

  it("REGRESSION: the purchase price is never copied into the selling-price field — SellingPriceField only ever receives sellingPricePence (confirmed_price_pence), never purchaseMatch's price", () => {
    const sellingFieldUsageIndex = panelSource.indexOf("<SellingPriceField");
    const sellingFieldUsageBlock = panelSource.slice(sellingFieldUsageIndex, panelSource.indexOf("/>", sellingFieldUsageIndex));
    expect(sellingFieldUsageBlock).toContain("sellingPricePence={listing.sellingPricePence}");
    expect(sellingFieldUsageBlock).not.toContain("purchaseMatch");
  });

  it("duplicate purchase matches render safe identifying info (order date, description, price) — never silently picking one", () => {
    expect(panelSource).toContain('listing.purchaseMatch.status === "duplicate"');
    expect(panelSource).toContain("match.orderDate");
    expect(panelSource).toContain("match.itemDescription");
  });

  it("the workspace fetches confirmed_price_pence/purchase_match from the SAME existing listings-review feed — no separate purchases fetch on the client", () => {
    expect(workspaceSource).toContain("confirmed_price_pence: number | null;");
    expect(workspaceSource).toContain("purchase_match: SkuPurchaseMatch;");
    expect(workspaceSource).not.toContain('fetch("/api/purchases');
  });

  it("saving a price updates local state via handleSellingPriceSaved with no extra network round-trip", () => {
    expect(workspaceSource).toContain("const handleSellingPriceSaved = useCallback((listingId: string, pence: number) => {");
    expect(workspaceSource).toContain("onSellingPriceSaved={handleSellingPriceSaved}");
  });

  it("SellingPriceField: prevents duplicate submissions, keeps the entered value on a failed save, and shows Saving/Saved/Save failed states", () => {
    expect(fieldSource).toContain('if (status === "saving") return; // prevent duplicate submissions');
    expect(fieldSource).toMatch(/status === "saving" \? "Saving…" : "Save"/);
    expect(fieldSource).toContain('status === "saved"');
    expect(fieldSource).toContain('status === "error"');
    // On a failed save, inputValue is never reset — only status/errorMessage change.
    const catchBlockIndex = fieldSource.indexOf("if (!response.ok) {");
    const catchBlock = fieldSource.slice(catchBlockIndex, fieldSource.indexOf("}", fieldSource.indexOf("return;", catchBlockIndex)));
    expect(catchBlock).not.toContain("setInputValue");
  });

  it("SellingPriceField: uses the same parseSellingPricePounds the server authoritatively validates with, for instant client-side feedback", () => {
    expect(fieldSource).toContain('import { parseSellingPricePounds } from "@/lib/listing-studio/selling-price";');
    expect(fieldSource).toContain("const parsed = parseSellingPricePounds(inputValue);");
  });

  it("SellingPriceField: saves to the dedicated selling-price route, never the big Edit Fields PATCH route — no duplicated business logic", () => {
    expect(fieldSource).toContain("/selling-price`, {");
    expect(fieldSource).not.toContain("/fields`");
  });

  it("SellingPriceField: the initial input value is derived directly from the sellingPricePence prop — an existing saved price loads pre-filled, and survives a page refresh since it's re-fetched fresh from the server on every load", () => {
    expect(fieldSource).toContain('useState(sellingPricePence !== null ? (sellingPricePence / 100).toFixed(2) : "")');
  });

  it("SellingPriceField: the input is never disabled except while actively saving — a previously-saved price can always be edited again", () => {
    expect(fieldSource).toContain('disabled={status === "saving"}');
    expect(fieldSource).not.toMatch(/disabled\s*(?:=\s*\{)?(?:true|readOnly)/);
  });

  it("REGRESSION: no AI involvement anywhere in this feature — no Anthropic import, no analysis-run write, no AI cost-log write, in the selling-price route, the purchase-match lib, or the listings-review feed route", () => {
    const sellingPriceRouteSource = read("app/api/listing-studio/groups/[draftId]/selling-price/route.ts");
    const purchaseMatchLibSource = read("lib/listing-studio/purchase-match.ts");
    const listingsReviewRouteSource = read("app/api/listing-studio/listings-review/route.ts");
    for (const source of [sellingPriceRouteSource, purchaseMatchLibSource, listingsReviewRouteSource, fieldSource]) {
      expect(source).not.toContain("@anthropic-ai/sdk");
      expect(source).not.toContain("listing_analysis_runs");
      expect(source).not.toContain("vinted_category_selection_ai_calls");
    }
  });
});
