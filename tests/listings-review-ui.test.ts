import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";

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

  it("no longer renders its own heading — ListingsReviewWorkspace renders it alongside the real KPI cards, which need client-fetched data this server component doesn't have", () => {
    expect(source).not.toContain("<h1>");
    expect(source).toContain("<ListingsReviewWorkspace />");
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
    it("has a 4-value top tab (readiness + workflow, never merged) plus a multi-select quick-filter Set, both feeding the same filteredRows computation", () => {
      expect(source).toContain('const [topTab, setTopTab] = useState<TopTab>("all");');
      expect(source).toContain("const [activeQuickFilters, setActiveQuickFilters] = useState<Set<ListingQuickFilter>>(new Set());");
      expect(source).toContain('if (topTab === "ready" && row.status === "needs_review") return false;');
      expect(source).toContain('if (topTab === "needs_review" && row.status !== "needs_review") return false;');
      expect(source).toContain('if (topTab === "drafted" && row.workflowStatus !== "drafted") return false;');
      expect(source).toContain("for (const filter of activeQuickFilters) if (!matchesQuickFilter(row, filter)) return false;");
    });

    it("Sent, Edited, and Draft-failed stay reachable via dedicated Filters toggles, never hidden, even though they aren't top tabs (the approved reference shows exactly 4 tabs)", () => {
      expect(source).toContain("const [showEditedOnly, setShowEditedOnly] = useState(false);");
      expect(source).toContain("const [showFailedOnly, setShowFailedOnly] = useState(false);");
      expect(source).toContain("const [showSentOnly, setShowSentOnly] = useState(false);");
      expect(source).toContain('if (showEditedOnly && row.status !== "edited") return false;');
      expect(source).toContain('if (showFailedOnly && row.workflowStatus !== "failed") return false;');
      expect(source).toContain("if (showSentOnly && !(row.workflowStatus !== null && (WORKFLOW_STATUS_TAB_GROUPS.sent as string[]).includes(row.workflowStatus))) return false;");
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

    it("Follow-up correction (closing the Mark Ready readiness gap): the bulk summary tallies each individual missing-field reason from the route's `warnings` array, not just the whole joined error string", () => {
      const bulkMarkReadyBlock = source.slice(source.indexOf("async function handleBulkMarkReady"), source.indexOf("async function commitDelete"));
      expect(bulkMarkReadyBlock).toContain("Array.isArray(body.warnings)");
      expect(bulkMarkReadyBlock).toContain("for (const reason of reasons)");
    });

    it("bulk delete reuses the EXISTING single-group DELETE route with mode 'delete_photos' — never a new bulk-delete endpoint", () => {
      expect(source).toContain('method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "delete_photos" }),');
    });

    it("Export has a real handler (inside the bulk bar's overflow menu) and 'Send {n} to extension' is a real, working primary action", () => {
      expect(source).toContain("onClick: handleExport");
      expect(source).not.toContain("List automatically");
      expect(source).toContain("`Send ${bulkCount} to extension`");
      expect(source).toContain("onClick={() => handleSendToExtension()}");
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
      expect(source).toContain("const baseListingRows = useMemo(() => drafts.map(draft => {");
      expect(source).toContain("const listingsById = useMemo(() => new Map(listingRows.map(row => [row.id, row])), [listingRows]);");
      expect(source).toContain("const filteredRows = useMemo(() => listingRows.filter(row => {");
    });

    it("workflow status (and its secondary-line inputs) is layered on top of the base rows in its OWN memo (depends on liveItemByDraftId, itself derived from batchStatusById), so a 4s poll tick never re-runs the full base pipeline — only this small mapping", () => {
      expect(source).toContain("const listingRows: ListingRow[] = useMemo(() => baseListingRows.map(row => {");
      expect(source).toContain("}), [baseListingRows, liveItemByDraftId]);");
      expect(source).toContain("const queuePosition = live ? live.item.queuePosition : row.extensionStatusSnapshot?.queue_position ?? null;");
    });

    it("multi-batch: liveItemByDraftId is its own memo keyed only on batchStatusById, so the per-draft live-status lookup is built once per poll cycle, not once per row", () => {
      expect(source).toContain("const liveItemByDraftId = useMemo(() => {");
      expect(source).toContain("}, [batchStatusById]);");
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

describe("components/listings-review/ListingsTable.tsx — visual-accuracy redesign: dense reference table", () => {
  const source = read("components/listings-review/ListingsTable.tsx");

  it("is memo()'d", () => {
    expect(source).toContain("export default memo(ListingsTable);");
  });

  it("has exactly the reference's required columns: Photo, Listing, Size, Cost, Price, Profit, Workflow (plus the bulk-select checkbox column and a row-actions column)", () => {
    for (const column of ["Photo", "Listing", "Size", "Cost", "Price", "Profit", "Workflow"]) {
      expect(source).toContain(`<th>${column}</th>`);
    }
  });

  it("Listing is one merged cell — title as the primary row text, SKU underneath in muted text — never two separate top-level columns", () => {
    expect(source).toContain('<span className="lr-title-text">{row.generatedTitle || "Untitled listing"}</span>');
    expect(source).toContain('<span className="lr-title-sku">{row.sku || "No SKU"}</span>');
    expect(source).not.toContain("<th>Brand</th>");
  });

  it("Cost/Price/Profit render '—' for missing data rather than a misleading number, and reuse formatPenceAsGBP", () => {
    expect(source).toContain('import { formatPenceAsGBP } from "@/lib/listing-studio/selling-price";');
    expect(source).toContain('row.costPence !== null ? formatPenceAsGBP(row.costPence) : "—"');
    expect(source).toContain('row.profitPence !== null ? formatPenceAsGBP(row.profitPence) : "—"');
  });

  it("Workflow is a bare illuminated dot + text (with an optional truthful secondary line) via the ONE shared WorkflowStatus component — workflow status wins when present, readiness otherwise — colour is never the only signal", () => {
    expect(source).toContain('import { WorkflowStatus } from "./WorkflowStatus";');
    expect(source).toContain("const displayLabel = row.workflowStatus ? WORKFLOW_STATUS_LABELS[row.workflowStatus] : READINESS_LABELS[row.status];");
    expect(source).toContain("computeWorkflowSecondaryLine({");
    expect(source).toContain('<WorkflowStatus label={displayLabel} tone={displayTone} pulse={row.workflowStatus === "in_progress"} secondaryLine={secondaryLine} />');
  });

  it("the pulse animation is reserved for the single item genuinely 'in_progress' right now, and shared by both the desktop table and the mobile card list via one WorkflowStatus component", () => {
    const matches = source.match(/pulse=\{row\.workflowStatus === "in_progress"\}/g) ?? [];
    expect(matches.length).toBe(2); // once in the table, once in the mobile card list
  });

  it("the header checkbox exposes a real indeterminate state (set imperatively via a ref, since HTML has no declarative attribute for it), recomputed from the currently visible rows", () => {
    expect(source).toContain("const selectAllRef = useRef<HTMLInputElement>(null);");
    expect(source).toContain("selectAllRef.current.indeterminate = someSelected;");
    expect(source).toContain("const someSelected = selectedCount > 0 && !allSelected;");
  });

  it("each row's overflow menu wires Preview/Edit fields to real, already-existing callbacks, plus a real Send/Resend when eligible — never a new endpoint", () => {
    expect(source).toContain('{ label: "Preview listing", onClick: () => handlers.onPreview(row.id) }');
    expect(source).toContain('{ label: "Edit fields", onClick: () => handlers.onEditFields(row.id) }');
    expect(source).toContain("handlers.onSendToExtension");
  });

  it("REGRESSION: clicking the row-select checkbox stops propagation so it never also triggers the row's own onSelectListing click", () => {
    expect(source).toContain('<td className="lr-checkbox-cell" onClick={event => event.stopPropagation()}>');
  });

  it("clicking anywhere else on the row selects it into the detail panel", () => {
    expect(source).toContain("onClick={() => onSelectListing(row.id)}");
  });

  it("highlights the currently selected row with a distinct class (the reference's restrained blue-violet background)", () => {
    expect(source).toContain('className={row.id === selectedListingId ? "lr-row lr-row-active" : "lr-row"}');
  });

  it("shows an empty state when the filtered row list is empty, rather than an empty table body", () => {
    expect(source).toContain("rows.length === 0");
    expect(source).toContain("No listings match.");
  });
});

describe("components/listings-review/WorkflowStatus.tsx — the ONE shared status-dot component", () => {
  const source = read("components/listings-review/WorkflowStatus.tsx");

  it("is a bare circular dot (no square/pill/badge backplate) plus adjacent label text, with an optional secondary line — colour is never the only signal", () => {
    expect(source).toContain('className={`lr-workflow-dot${pulse ? " lr-workflow-dot-pulse" : ""}`}');
    expect(source).toContain('style={{ "--tone": tone } as CSSProperties}');
    expect(source).toContain("{label}");
    expect(source).toContain("{secondaryLine && <span className=\"lr-workflow-secondary\">{secondaryLine}</span>}");
  });
});

describe("lib/listing-studio/extension-workflow-status.ts — exact reference colours + secondary-line source of truth", () => {
  const source = read("lib/listing-studio/extension-workflow-status.ts");

  it("uses the exact approved-reference hex colours for every workflow status", () => {
    expect(source).toContain('sent: "#8B7CFF",');
    expect(source).toContain('in_queue: "#7E8798",');
    expect(source).toContain('in_progress: "#3F8CFF",');
    expect(source).toContain('drafted: "#2FCB75",');
    expect(source).toContain('failed: "#FF4D57",');
  });

  it("exports the exact readiness tones (Ready reuses the same emerald as drafted; Needs review is the one amber)", () => {
    expect(source).toContain('export const READINESS_TONE_READY = "#2FCB75";');
    expect(source).toContain('export const READINESS_TONE_NEEDS_REVIEW = "#F4AC32";');
  });

  it("computeWorkflowSecondaryLine is the ONE place a secondary line is ever derived — position for in_queue, real detail/step for in_progress, real draft id for drafted, real error for failed, nothing for every other status", () => {
    expect(source).toContain("export function computeWorkflowSecondaryLine(input: {");
    expect(source).toContain('case "in_queue":');
    expect(source).toContain("return input.queuePosition !== null ? `Position ${input.queuePosition + 1}` : null;");
    expect(source).toContain('case "in_progress":');
    expect(source).toContain("return input.detail || (input.currentStep ? (STEP_LABELS[input.currentStep] ?? input.currentStep) : null);");
    expect(source).toContain('case "drafted":');
    expect(source).toContain("return input.vintedDraftId ? `Draft #${input.vintedDraftId}` : null;");
    expect(source).toContain('case "failed":');
    expect(source).toContain("return input.errorMessage || null;");
  });

  it("REGRESSION: 'Item drafted' can never be shown without a real, confirmed Vinted draft id — computeExtensionWorkflowStatus only ever returns 'drafted' for a genuinely completed item status, and the secondary line itself requires vintedDraftId to render anything", () => {
    expect(source).toContain('if (itemStatus === "completed") return "drafted";');
    expect(source).not.toMatch(/"saving".*return "drafted"/);
  });
});

describe("components/listings-review/ListingDetailsPanel.tsx — visual-accuracy redesign: compact inspector", () => {
  const source = read("components/listings-review/ListingDetailsPanel.tsx");

  it("is memo()'d and shows a placeholder when nothing is selected, rather than being unmounted/hidden entirely", () => {
    expect(source).toContain("export default memo(ListingDetailsPanel);");
    expect(source).toContain("lr-inspector-empty");
  });

  it("displays the compact card's required fields: medium 16:9 image, up to 5 thumbnails, position indicator, generated title, SKU/UK size line, cost/price/profit row, and a metadata grid trimmed to exactly Brand/Category/Condition/Colour(s) (matching the reference exactly)", () => {
    expect(source).toContain('className="lr-inspector-image"');
    const css = read("app/globals.css");
    expect(css).toContain(".lr-inspector-image { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }");
    expect(source).toContain('className="lr-inspector-title"');
    expect(source).toContain("const thumbnailIds = listing.photoIds.slice(0, 5);");
    expect(source).toContain('{position && <span className="lr-inspector-position">{position.index + 1} of {position.total}</span>}');
    expect(source).toContain('<p className="lr-inspector-sku">{listing.sku || "No SKU"} {listing.ukSize && `· UK ${listing.ukSize}`}</p>');
    expect(source).toContain('className="lr-inspector-money"');
    for (const field of ["Brand", "Category", "Condition"]) {
      expect(source).toContain(`<dt>${field}</dt>`);
    }
    // The description paragraph and the Model/Material/Vinted-audience rows
    // are deliberately no longer part of the compact grid (not in the
    // reference) — Preview/Edit still show/edit them in full.
    expect(source).not.toContain("lr-inspector-description");
  });

  it("clicking a thumbnail swaps the main displayed image (never just opens the carousel) — the active thumbnail gets a thin violet border; clicking the main image itself opens the full carousel", () => {
    expect(source).toContain("const [activePhotoId, setActivePhotoId] = useState<string | null>(null);");
    expect(source).toContain("useEffect(() => { setActivePhotoId(null); }, [listing?.id]);");
    expect(source).toContain("onClick={() => setActivePhotoId(photoId)}");
    expect(source).toContain('className={photoId === mainPhotoId ? "lr-inspector-thumb lr-inspector-thumb-active" : "lr-inspector-thumb"}');
    expect(source).toContain("onClick={() => onOpenCarousel(listing.id, mainPhotoId ?? undefined)}");
  });

  it("Milestone 6 (Vinted-aware colours/materials): shows both colours when two exist, joined the same way the title does, and the colour dt pluralises to 'Colours' when there are two", () => {
    expect(source).toContain('<div><dt>Colour{listing.colours.length > 1 ? "s" : ""}</dt><dd>{listing.colours.length > 0 ? listing.colours.join(" & ") : "Not set"}</dd></div>');
  });

  it("REGRESSION: never shows an AI confidence value anywhere — warnings replace it entirely", () => {
    expect(source).not.toMatch(/confidence/i);
  });

  it("has exactly the reference's 2-button primary action row — Edit, Preview — plus a small overflow menu for Assign category/Reassess audience/Mark ready/Send-Resend (all fully preserved, never deleted, just relocated out of the primary row to match the reference)", () => {
    expect(source).toContain('<button type="button" className="button-secondary" onClick={() => onEditFields(listing.id)}>Edit</button>');
    expect(source).toContain('<button type="button" className="button-secondary" onClick={() => onPreview(listing.id)}>Preview</button>');
    expect(source).toContain('label="More actions for this listing"');
    expect(source).toMatch(/Assign category/);
    expect(source).toMatch(/Mark ready/);
  });

  it("REGRESSION: Mark Ready is only ever actionable on an Edited listing — disabled for Ready (nothing to do) and Needs Review (missing fields always win, no override)", () => {
    expect(source).toContain('disabled: markingReady || listing.status !== "edited"');
  });

  it("clicking the cover image opens the photo carousel for this listing, and is disabled when there's no photo at all", () => {
    expect(source).toContain("disabled={!mainPhotoId}");
  });

  it("renders one warning per entry from the listing's own warnings array — nothing hardcoded", () => {
    expect(source).toContain("{listing.warnings.map(warning => <li key={warning}");
  });

  it("the Workflow status shown here uses the exact same shared WorkflowStatus component and secondary-line logic as the table — never a second status language", () => {
    expect(source).toContain('import { WorkflowStatus } from "./WorkflowStatus";');
    expect(source).toContain("computeWorkflowSecondaryLine({");
  });
});

describe("components/listings-review/ListingsFilterBar.tsx — visual-accuracy redesign: 4-tab toolbar", () => {
  const source = read("components/listings-review/ListingsFilterBar.tsx");

  it("is memo()'d", () => {
    expect(source).toContain("export default memo(ListingsFilterBar);");
  });

  it("has exactly the reference's 4 top tabs: All, Ready, Need review, Drafts — readiness and extension workflow, never merged, with real counts", () => {
    expect(source).toContain('{ value: "all", label: "All" }');
    expect(source).toContain('{ value: "ready", label: "Ready", tone: READINESS_TONE_READY }');
    expect(source).toContain('{ value: "needs_review", label: "Need review", tone: READINESS_TONE_NEEDS_REVIEW }');
    expect(source).toContain('{ value: "drafted", label: "Drafts", tone: WORKFLOW_STATUS_TONE.drafted }');
    expect(source).not.toContain('{ value: "sent", label: "Sent"');
  });

  it("Sent (in flight), Edited, and Draft failed are NOT top tabs (matching the reference's exact 4 tabs) but stay reachable inside the Filters popover — never hidden", () => {
    expect(source).toContain("onClick={onToggleSentOnly}");
    expect(source).toContain("onClick={onToggleFailedOnly}");
    expect(source).toContain("onClick={onToggleEditedOnly}");
    expect(source).toMatch(/>\s*Sent \(\{sentCount\}\)\s*</);
    expect(source).toMatch(/>\s*Draft failed \(\{failedCount\}\)\s*</);
    expect(source).toMatch(/>\s*Edited\s*</);
  });

  it("Clear filters only renders when a filter is actually active", () => {
    expect(source).toContain('{filtersActive && <button type="button" className="lr-clear-filters" onClick={onClearFilters}>Clear filters</button>}');
  });

  it("has a Filters button with a small icon, and the exact reference search placeholder", () => {
    expect(source).toContain("<FilterIcon /> Filters");
    expect(source).toContain('placeholder="Search titles or SKU…"');
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

  it("Milestone 6: shows the real saved selling price when set, the explicit placeholder only when it isn't", () => {
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

describe("app/globals.css — visual-accuracy redesign: --lr-* tokens and every new component styled", () => {
  const css = read("app/globals.css");

  it("styles the workspace split, dense table, workflow dot, compact inspector, activity panel, warnings, carousel, and the extended preview card", () => {
    for (const selector of [
      ".lr-workspace", ".lr-rail", ".lr-table", ".lr-workflow-status-row",
      ".lr-inspector", ".lr-inspector-warning", ".lr-activity-panel",
      ".photo-carousel-thumbnail-strip", ".preview-listing-vinted-card",
    ]) {
      expect(css).toContain(selector);
    }
  });

  it("defines the exact approved dark palette as --lr-* tokens scoped to .dark .listings-review-page, with a light-mode fallback derived from this app's own existing light tokens (never leaking into any other page)", () => {
    expect(css).toContain(".dark .listings-review-page {");
    expect(css).toContain("--lr-green: #2fcb75;");
    expect(css).toContain("--lr-blue: #3f8cff;");
    expect(css).toContain("--lr-amber: #f4ac32;");
    expect(css).toContain("--lr-red: #ff4d57;");
    expect(css).toContain("--lr-violet: #7c6cf2;");
    expect(css).toContain("--lr-page: #090d14;");
  });

  it("the workflow dot is a BARE circle (no square/pill backplate) at the exact approved 8px/glow spec", () => {
    expect(css).toContain(".lr-workflow-dot { width: 8px; height: 8px; border-radius: 999px; flex: 0 0 8px; background: var(--tone); box-shadow: 0 0 0 4px color-mix(in srgb, var(--tone) 14%, transparent), 0 0 8px color-mix(in srgb, var(--tone) 55%, transparent); }");
  });

  it("the in-progress pulse animation is guarded behind prefers-reduced-motion, and never applied to any status other than in_progress", () => {
    expect(css).toContain("@media (prefers-reduced-motion: no-preference) {");
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.lr-workflow-dot-pulse \{ animation: lrWorkflowPulse/);
  });

  it("REGRESSION: every redesign responsive override for this page sits strictly AFTER its own base rule in source order (the same cascade-order class of bug caught live during the Listing Studio redesign)", () => {
    const baseIdx = css.indexOf(".lr-topline {");
    const overrideIdx = css.lastIndexOf(".lr-bulk-bar-actions .button, .lr-bulk-bar-actions .button-secondary, .lr-bulk-bar-actions .button-danger { flex: 1 1 auto; min-width: 0; }");
    expect(baseIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeGreaterThan(baseIdx);
  });

  it("Milestone 6: styles the purchase-price section and the selling-price control", () => {
    for (const selector of [".lr-inspector-purchase", ".lr-inspector-purchase-line", ".lr-selling-price-row", ".lr-selling-price-status"]) {
      expect(css).toContain(selector);
    }
  });

  it("money columns are wide enough that a genuine four-figure amount (e.g. £1,234.56) never truncates or ellipsises, and are right-aligned per a professional financial table", () => {
    expect(css).toMatch(/\.lr-table th:nth-child\(5\), \.lr-table td:nth-child\(5\),\s*\n\s*\.lr-table th:nth-child\(6\), \.lr-table td:nth-child\(6\),\s*\n\s*\.lr-table th:nth-child\(7\), \.lr-table td:nth-child\(7\) \{ width: 84px; text-align: right; \}/);
    expect(css).toContain(".lr-money-cell { overflow: hidden; color: var(--lr-text); font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; text-align: right; }");
  });

  it("rows are dense at the reference's 72-80px height, with a 50-56px thumbnail", () => {
    expect(css).toContain(".lr-row { cursor: pointer; height: 76px; transition: background 100ms ease; }");
    expect(css).toContain(".lr-cover-thumb { width: 52px; height: 52px; border-radius: 6px; object-fit: cover; }");
  });

  it("the selected-row background is the restrained violet-soft treatment, matching the reference", () => {
    expect(css).toContain(".lr-row-active, .lr-row-active:hover { background: var(--lr-violet-soft); }");
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

  it("SellingPriceField: the initial input value is derived directly from the sellingPricePence prop", () => {
    expect(fieldSource).toContain('useState(sellingPricePence !== null ? (sellingPricePence / 100).toFixed(2) : "")');
  });

  it("SellingPriceField: the input is never disabled except while actively saving", () => {
    expect(fieldSource).toContain('disabled={status === "saving"}');
    expect(fieldSource).not.toMatch(/disabled\s*(?:=\s*\{)?(?:true|readOnly)/);
  });

  it("REGRESSION: no AI involvement anywhere in this feature", () => {
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

describe("Milestone 7 (revised) — Vinted Draft Export UI wiring", () => {
  const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");

  it("the Export button calls handleExport", () => {
    expect(workspaceSource).toContain("onClick: handleExport");
  });

  it("the Export button is disabled while a request is in flight — prevents duplicate clicks", () => {
    expect(workspaceSource).toMatch(/disabled: exportRunning \|\| bulkCount > MAX_EXPORT_LISTINGS_PER_BATCH,/);
  });

  it("shows step-by-step progress labels while exporting", () => {
    expect(workspaceSource).toContain("Validating listings…");
    expect(workspaceSource).toContain("Preparing photos and creating package…");
    expect(workspaceSource).toContain("Downloading…");
  });

  it("REGRESSION: a failed export never clears the current bulk selection — only a genuine success does", () => {
    const exportFn = workspaceSource.slice(workspaceSource.indexOf("async function handleExport"), workspaceSource.indexOf("async function handleSendToExtension"));
    const catchBlock = exportFn.slice(exportFn.indexOf("} catch"));
    expect(catchBlock).not.toContain("setBulkSelectedIds(new Set())");
    const successPath = exportFn.slice(exportFn.indexOf("setBulkActionMessage"), exportFn.indexOf("} catch"));
    expect(successPath).toContain("setBulkSelectedIds(new Set())");
  });

  it("REGRESSION: a rejected export reports the specific rejected listings and their reasons, never just a generic message", () => {
    expect(workspaceSource).toContain("setExportRejected(Array.isArray(body.rejected) ? body.rejected : [])");
    expect(workspaceSource).toContain("{exportRejected.map(item =>");
  });

  it("enforces the batch maximum client-side too, with a clear message, before ever calling the server", () => {
    expect(workspaceSource).toContain("if (ids.length > MAX_EXPORT_LISTINGS_PER_BATCH)");
    expect(workspaceSource).toMatch(/Select at most \$\{MAX_EXPORT_LISTINGS_PER_BATCH\} listings/);
  });

  it("success wording says 'Exported', never 'Published' or 'Listed'", () => {
    expect(workspaceSource).toMatch(/Exported \$\{ids\.length\}/);
    expect(workspaceSource).not.toMatch(/\bpublished\b|listed live\b|now live\b/i);
  });

  it("REGRESSION: never sends one request per listing — exactly one POST to the export route with every selected draftId in one body", () => {
    expect(workspaceSource).toContain('fetch("/api/listing-studio/listings-review/export"');
    expect(workspaceSource).toContain("body: JSON.stringify({ draftIds: ids })");
  });

  it("triggers the browser's own download via a blob object URL, never navigating away from the page", () => {
    expect(workspaceSource).toContain("URL.createObjectURL(blob)");
    expect(workspaceSource).toContain("URL.revokeObjectURL(objectUrl)");
    expect(workspaceSource).toContain("link.download = fileName");
  });

  it("this feature never talks to Vinted, never publishes, and allows any number of listings up to the batch max (never restricted to exactly one)", () => {
    expect(workspaceSource).not.toMatch(/vinted\.co\.uk|vinted\.com/i);
    expect(workspaceSource).not.toMatch(/exactly one listing/i);
  });
});

describe("app/api/listing-studio/listings-review/export/route.ts — Milestone 7 (revised): safety-by-construction", () => {
  const routeSource = read("app/api/listing-studio/listings-review/export/route.ts");

  it("requires the owner and never trusts a client-supplied Ready status", () => {
    expect(routeSource).toContain("await requireOwner()");
    expect(routeSource).toContain("buildListingWarnings(readinessFields)");
  });

  it("REGRESSION: there is no publish/list/upload-live function, route, or button anywhere in this feature", () => {
    for (const source of [routeSource, read("components/listings-review/ListingsReviewWorkspace.tsx"), read("lib/listing-studio/vinted-export-schema.ts"), read("lib/listing-studio/vinted-export-photos.ts")]) {
      expect(source.toLowerCase()).not.toMatch(/publishlisting|createvinteddraft|listitemonvinted|uploadtovinted/);
    }
  });

  it("never sets vinted_draft_created_at — only the extension result route may ever do that", () => {
    expect(routeSource).not.toContain("vinted_draft_created_at:");
  });

  it("sets vinted_exported_at/vinted_export_id only AFTER the ZIP buffer was already built", () => {
    const buildIndex = routeSource.indexOf("buildZipBuffer(zipEntries)");
    const trackingIndex = routeSource.indexOf("vinted_exported_at: createdAt");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(trackingIndex).toBeGreaterThan(buildIndex);
  });

  it("uses the app's existing HEIC conversion approach (heic-convert), never a new/different one", () => {
    const photosSource = read("lib/listing-studio/vinted-export-photos.ts");
    expect(photosSource).toContain("heic-convert");
  });

  it("never exposes the Supabase service-role key to the response", () => {
    expect(routeSource).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(routeSource).not.toContain("SUPABASE_SECRET_KEY");
  });
});

describe("Milestone 7 (Chrome extension draft queue), extended for multi-batch support — 'Send to extension' UI wiring", () => {
  const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");

  it("the button exists, calls handleSendToExtension, and is only rendered inside the bulk bar (bulkCount > 0), which now lives inside the table column", () => {
    expect(workspaceSource).toContain("`Send ${bulkCount} to extension`");
    expect(workspaceSource).toContain("onClick={() => handleSendToExtension()}");
    expect(workspaceSource).toContain('{bulkCount > 0 && <div className="lr-bulk-bar"');
  });

  it("enforces the 5-listing maximum (MAX_EXTENSION_BATCH_LISTINGS) both in the disabled condition and inside the handler itself", () => {
    expect(workspaceSource).toContain("import { MAX_EXTENSION_BATCH_LISTINGS } from \"@/lib/listing-studio/extension-batch-schema\"");
    expect(workspaceSource).toMatch(/disabled=\{sendToExtensionRunning \|\| bulkCount > MAX_EXTENSION_BATCH_LISTINGS\}/);
    expect(workspaceSource).toContain("if (ids.length > MAX_EXTENSION_BATCH_LISTINGS)");
  });

  it("REGRESSION (multi-batch support): the button is NEVER disabled by the existence of another batch — no Boolean(activeBatchId)-shaped condition, and no `const [activeBatchId, ...]` state, survives anywhere in this file, so a second (or third, or Nth) batch can always be sent without cancelling an existing one", () => {
    expect(workspaceSource).not.toMatch(/Boolean\(activeBatchId\)/);
    expect(workspaceSource).not.toMatch(/const \[activeBatchId,/);
  });

  it("multi-batch: creating a batch adds its id to visibleBatchIds/batchMetaById/pairingCodeById — it never resets or replaces any other batch's entry in those maps", () => {
    expect(workspaceSource).toContain("setVisibleBatchIds(current => new Set(current).add(batchId));");
    expect(workspaceSource).toContain("setBatchMetaById(current => new Map(current).set(batchId, { displayNumber: body.displayNumber, browserLabel: null }));");
    expect(workspaceSource).toContain("setPairingCodeById(current => new Map(current).set(batchId, body.pairingCode));");
  });

  it("shows the pairing code and its real expiry (never a vague 'expires soon') once a batch is created — now rendered per-batch by ExtensionBatchGrid", () => {
    const gridSource = read("components/listings-review/ExtensionBatchGrid.tsx");
    expect(gridSource).toContain("Waiting for pairing");
    expect(gridSource).toContain("lr-pairing-code");
    expect(gridSource).toContain("formatRelativeMinutes(box.expiresAt)");
    expect(gridSource).toContain("function formatRelativeMinutes(isoTimestamp: string): string {");
  });

  it("shows whether the extension has claimed a batch (claimed/in_progress) distinctly from the pre-claim pairing-code view, per box — ExtensionBatchGrid.tsx", () => {
    const gridSource = read("components/listings-review/ExtensionBatchGrid.tsx");
    expect(gridSource).toContain('box.status === "claimed" || box.status === "in_progress"');
    expect(gridSource).toContain("Processing —");
  });

  it("displays live per-item progress via the table's own Workflow column and Live Activity — the old inline per-item queue list is gone, not duplicated", () => {
    expect(workspaceSource).not.toContain("batchStatus.items.map(item =>");
    expect(workspaceSource).toContain("const live = liveItemByDraftId.get(row.id);");
    expect(workspaceSource).toContain("item.errorMessage");
  });

  it("polls the owner-authenticated batch-status endpoint (never the extension's bearer-token one) on a bounded cadence, in parallel for every tracked batch, and stops polling a batch once IT is terminal", () => {
    expect(workspaceSource).toContain("fetch(`/api/listing-studio/extension-batches/${id}`)");
    expect(workspaceSource).toContain("timeoutId = setTimeout(poll, 4000);");
    expect(workspaceSource).toContain("!isBatchStatusTerminal(known.status);");
    expect(workspaceSource).toContain("if (timeoutId !== undefined) clearTimeout(timeoutId);");
  });

  // REGRESSION (Listings Review final-item workflow-status bug, generalised
  // for multi-batch): the poll used to be a setInterval whose callback
  // checked a `batchStatus` value read from the enclosing effect's closure
  // — frozen at whatever it was when the effect first ran, since the
  // effect deliberately never re-ran on a batchStatus change. The fix
  // replaced the interval with a self-rescheduling poll that decides using
  // the response it JUST fetched, never a value frozen in a stale closure.
  // Generalised to multi-batch: every batch's own result is merged via
  // applyBatchResult (setBatchStatusById) BEFORE the next cycle is ever
  // scheduled, so no batch can be treated as reconciled in the UI, and
  // polling can never stop for it, until its own terminal state has
  // already been applied.
  it("REGRESSION: every batch's result is applied to state before the next poll cycle is scheduled — never a value frozen in a stale closure", () => {
    expect(workspaceSource).not.toContain("setInterval(");
    expect(workspaceSource).not.toContain("clearInterval(");
    const pollFnStart = workspaceSource.indexOf("async function poll() {");
    const pollFnEnd = workspaceSource.indexOf("\n    poll();", pollFnStart);
    const pollFn = workspaceSource.slice(pollFnStart, pollFnEnd);
    expect(pollFn).toContain("applyBatchResult(result.id, result.body);");
    expect(pollFn).toContain("if (!cancelled) timeoutId = setTimeout(poll, 4000);");
    // The authoritative per-batch merge must happen BEFORE the next cycle
    // is scheduled — never the reverse, which could schedule the next
    // fetch before a just-arrived terminal state was ever applied.
    expect(pollFn.indexOf("applyBatchResult(result.id, result.body);")).toBeLessThan(pollFn.lastIndexOf("timeoutId = setTimeout(poll, 4000);"));
  });

  it("REGRESSION: a stale/out-of-order poll CYCLE (one cycle = every tracked batch fetched in parallel) can never overwrite a newer, already-applied one", () => {
    expect(workspaceSource).toContain("shouldApplyBatchPollResponse(appliedSeq, seq)");
    expect(workspaceSource).toContain("appliedSeq = seq;");
  });

  it("multi-batch: the poll loop only starts/stops based on whether ANY batch is visible (hasVisibleBatches) — it does not restart every time a single batch is added or removed while already running", () => {
    expect(workspaceSource).toContain("const hasVisibleBatches = visibleBatchIds.size > 0;");
    expect(workspaceSource).toContain("}, [hasVisibleBatches]);");
    expect(workspaceSource).toContain("if (!hasVisibleBatches) return;");
  });

  it("a 404 for one batch during a poll cycle drops ONLY that batch from tracking — every other batch's own result in the same cycle is still applied normally", () => {
    const pollFnStart = workspaceSource.indexOf("async function poll() {");
    const pollFnEnd = workspaceSource.indexOf("\n    poll();", pollFnStart);
    const pollFn = workspaceSource.slice(pollFnStart, pollFnEnd);
    expect(pollFn).toContain("if (result.status === 404) {");
    expect(pollFn).toContain("continue;");
  });

  it("a rejected batch-creation request never clears the current selection, and shows the specific rejected listings", () => {
    const fn = workspaceSource.slice(workspaceSource.indexOf("async function handleSendToExtension"), workspaceSource.indexOf("const handleCancelBatch"));
    expect(fn).not.toContain("setBulkSelectedIds(new Set())");
    expect(workspaceSource).toContain("setSendToExtensionRejected(Array.isArray(body.rejected) ? body.rejected : [])");
  });

  it("makes it clear nothing will be published — a permanent safety badge sits in the page's own top line, always visible, not only while a batch is active", () => {
    expect(workspaceSource).toContain('<span className="lr-safety-badge">Drafts only — never publishes</span>');
  });

  it("never sends one request per listing — exactly one POST with every selected draftId in one body", () => {
    expect(workspaceSource).toContain('fetch("/api/listing-studio/extension-batches"');
    expect(workspaceSource).toContain("body: JSON.stringify({ draftIds: ids })");
  });

  it("multi-batch: cancels a SPECIFIC batch via its immutable id (handleCancelBatch), and dismissing a terminal batch's box (handleDismissBatchBox) removes it from local box-grid state without touching its activity", () => {
    expect(workspaceSource).toContain('await fetch(`/api/listing-studio/extension-batches/${batchId}`, { method: "DELETE" })');
    expect(workspaceSource).toContain("const handleDismissBatchBox = useCallback(async (batchId: string) => {");
    expect(workspaceSource).toContain('setVisibleBatchIds(current => { const next = new Set(current); next.delete(batchId); return next; });');
  });

  it("REGRESSION: the ZIP export feature (a separate, already-existing action) is untouched — both actions coexist in the same bulk bar", () => {
    expect(workspaceSource).toContain("onClick: handleExport");
    expect(workspaceSource).toContain("`Send ${bulkCount} to extension`");
  });

  it("the bulk bar's left side shows the real selected count with a working Clear selection button", () => {
    expect(workspaceSource).toContain('<strong>{bulkCount} selected</strong>');
    expect(workspaceSource).toContain('onClick={() => setBulkSelectedIds(new Set())}>Clear selection</button>');
  });
});

describe("Visual-accuracy redesign — 4 real KPI cards, canonical (no duplicated inline heading stats)", () => {
  const source = read("components/listings-review/ListingsReviewWorkspace.tsx");

  it("readyCount/needsReviewCount come ONLY from readiness (never from workflow status)", () => {
    expect(source).toContain('const readyCount = useMemo(() => listingRows.filter(row => row.status !== "needs_review").length, [listingRows]);');
    expect(source).toContain('const needsReviewCount = useMemo(() => listingRows.filter(row => row.status === "needs_review").length, [listingRows]);');
  });

  it("draftsCount/sentCount come ONLY from workflow status, via the shared WORKFLOW_STATUS_TAB_GROUPS — never re-implemented ad hoc", () => {
    expect(source).toContain("WORKFLOW_STATUS_TAB_GROUPS.drafts as string[]).includes(row.workflowStatus)");
    expect(source).toContain("WORKFLOW_STATUS_TAB_GROUPS.sent as string[]).includes(row.workflowStatus)");
  });

  it("draftingCount — the 4th KPI card — comes from real, persisted extension-item state (preparing/filling/saving), never a client-only guess", () => {
    expect(source).toContain('const draftingCount = useMemo(() => listingRows.filter(row => row.workflowStatus === "in_progress").length, [listingRows]);');
  });

  it("failedCount is computed and exposed to the Filters control — a failed listing is always visible somewhere, never hidden", () => {
    expect(source).toContain('const failedCount = useMemo(() => listingRows.filter(row => row.workflowStatus === "failed").length, [listingRows]);');
    expect(source).toContain("failedCount={failedCount}");
  });

  it("exactly 4 real KPI cards (Listings/Ready/Drafting/Need review) render real counts via the ONE shared KpiIcon component, and the totalCount passed to the filter bar matches the real row count", () => {
    expect(source).toContain('import { KpiIcon } from "./KpiIcon";');
    expect(source).toContain('<div><strong>{listingRows.length}</strong><span className="lr-kpi-label">Listings</span></div>');
    expect(source).toContain('<div><strong>{readyCount}</strong><span className="lr-kpi-label">Ready</span></div>');
    expect(source).toContain('<div><strong>{draftingCount}</strong><span className="lr-kpi-label">Drafting</span></div>');
    expect(source).toContain('<div><strong>{needsReviewCount}</strong><span className="lr-kpi-label">Need review</span></div>');
    expect(source).toContain('<KpiIcon tone="listings">');
    expect(source).toContain('<KpiIcon tone="ready">');
    expect(source).toContain('<KpiIcon tone="drafting">');
    expect(source).toContain('<KpiIcon tone="review">');
    expect(source).toContain("totalCount={listingRows.length}");
  });

  it("REGRESSION: the KPI icon wrapper has an explicit fixed size that cannot shrink, grid-centring, and no inherited line-height — the exact cause of a previous vertical-centring bug (a same-specificity-beating `.lr-kpi span` rule elsewhere forced `display: block` on this element) is structurally impossible now that the tone class lives directly on the icon and the label has its own dedicated class", () => {
    const css = read("app/globals.css");
    expect(css).toContain(".lr-kpi-icon { display: grid; width: 28px; height: 28px; flex: 0 0 auto; place-items: center; border-radius: 999px; line-height: 0; }");
    expect(css).toContain(".lr-kpi-icon > svg { display: block; margin: 0; }");
    expect(css).not.toContain(".lr-kpi span {");
    expect(css).not.toMatch(/\.lr-kpi-listings \.lr-kpi-icon|\.lr-kpi-ready \.lr-kpi-icon|\.lr-kpi-drafting \.lr-kpi-icon|\.lr-kpi-review \.lr-kpi-icon/);
  });

  it("REGRESSION: the inline heading stats style from the wider composite reference is never rendered alongside the 4 KPI cards — the cards are the sole place these totals appear", () => {
    expect(source).not.toMatch(/\d+ listings? · \d+ ready/);
  });

  it("clearFilters resets every filter dimension at once — top tab, category, quick filters, edited/failed/sent toggles, and search", () => {
    const fn = source.slice(source.indexOf("const clearFilters = useCallback"), source.indexOf("}, []);", source.indexOf("const clearFilters = useCallback")) + 8);
    expect(fn).toContain('setTopTab("all")');
    expect(fn).toContain('setCategoryFilter("all")');
    expect(fn).toContain("setActiveQuickFilters(new Set())");
    expect(fn).toContain("setShowEditedOnly(false)");
    expect(fn).toContain("setShowFailedOnly(false)");
    expect(fn).toContain("setShowSentOnly(false)");
    expect(fn).toContain('setSearchQuery("")');
  });
});

describe("Visual-accuracy redesign — category filter (client-side, no new fetch)", () => {
  const source = read("components/listings-review/ListingsReviewWorkspace.tsx");

  it("derives its options from already-loaded listingRows.productType — never a new fetch", () => {
    expect(source).toContain("const categoryOptions = useMemo(() => {");
    expect(source).toContain("listingRows.map(row => row.productType)");
  });

  it("filters by exact productType match when set to something other than 'all'", () => {
    expect(source).toContain('if (categoryFilter !== "all" && row.productType !== categoryFilter) return false;');
  });
});

describe("components/listings-review/DraftActivityPanel.tsx — Live Activity panel", () => {
  const source = read("components/listings-review/DraftActivityPanel.tsx");

  it("is memo()'d and takes only already-derived events — never fetches or computes anything itself", () => {
    expect(source).toContain("export default memo(DraftActivityPanel);");
    expect(source).not.toMatch(/fetch\(/);
  });

  it("the header reads exactly 'Live activity' with a small green live dot shown only while isLive is true, and 'View all' (not 'View all activity')", () => {
    expect(source).toContain('aria-label="Live activity"');
    expect(source).toContain("{isLive && <i aria-hidden=\"true\" className=\"lr-activity-live-dot\" />}Live activity");
    expect(source).toContain('{showAll ? "Show less" : "View all"}');
  });

  it("each row shows the timestamp FIRST (reference image 4's own row order), then the dot, then the message", () => {
    const rowIndex = source.indexOf('<li key={event.id}');
    const rowBlock = source.slice(rowIndex, source.indexOf("</li>", rowIndex));
    const timeIdx = rowBlock.indexOf("lr-activity-time");
    const dotIdx = rowBlock.indexOf("lr-activity-dot ");
    expect(timeIdx).toBeGreaterThan(-1);
    expect(dotIdx).toBeGreaterThan(timeIdx);
  });

  it("caps visible rows and only reveals the rest via an explicit 'View all' toggle over the SAME in-memory array — no second, larger backing store", () => {
    expect(source).toContain("const COLLAPSED_VISIBLE_COUNT = 6;");
    expect(source).toContain("const visibleEvents = showAll ? events : events.slice(0, COLLAPSED_VISIBLE_COUNT);");
  });

  it("renders no Retry button/control anywhere — the existing recourse for a failed item (resend, via the table row/inspector overflow menu) is unchanged", () => {
    expect(source).not.toMatch(/<button[^>]*>\s*Retry/i);
    expect(source).not.toMatch(/onRetry/);
  });

  it("every event row shows a dot, a message, and a short timestamp — colour is never the only signal (a screen-reader-only tone label precedes the message)", () => {
    expect(source).toContain('<i aria-hidden="true" className={`lr-activity-dot lr-activity-dot-${event.tone}`} />');
    expect(source).toContain('<span className="sr-only">{TONE_LABELS[event.tone]}: </span>');
    expect(source).toContain("formatShortTimestamp(event.timestampIso)");
  });

  it("the event list is a polite, additions-only live region — new events are announced without re-reading the whole history", () => {
    expect(source).toContain('aria-live="polite" aria-relevant="additions"');
  });
});

describe("Polish pass — the bottom-right toast/notification system was removed entirely from Listings Review", () => {
  const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");
  const css = read("app/globals.css");

  it("REGRESSION: the redundant fixed toast stack no longer exists as a file, and Listings Review no longer imports or renders it — Live Activity is now the ONE place detailed extension progress is ever shown", () => {
    expect(existsSync("components/listings-review/ExtensionNotifications.tsx")).toBe(false);
    expect(workspaceSource).not.toContain("import ExtensionNotifications");
    expect(workspaceSource).not.toMatch(/<ExtensionNotifications\b/);
    expect(workspaceSource).not.toContain(": ExtensionNotification[]");
  });

  it("no obsolete .lr-toast-* CSS rule remains anywhere in the stylesheet — not merely hidden, shrunk, or made transparent, but genuinely removed (a plain-language comment explaining WHY it was removed is fine and expected; an actual rule declaration is not)", () => {
    expect(css).not.toMatch(/\.lr-toast[a-z-]*\s*\{/);
  });

  it("REGRESSION: no now-unused toast state, timers, or callbacks remain on the workspace — the notifications array, upsertNotifications, and dismissNotification are all gone as real code (not merely renamed)", () => {
    expect(workspaceSource).not.toMatch(/const \[notifications, setNotifications\]/);
    expect(workspaceSource).not.toMatch(/function upsertNotifications|const upsertNotifications = /);
    expect(workspaceSource).not.toMatch(/function dismissNotification|const dismissNotification = /);
  });

  it("this was the same redundant Listing Review implementation confirmed unused elsewhere before removal — the unrelated .task-toast system (Tasks feature) is untouched", () => {
    expect(css).toContain(".task-toast {");
  });
});

describe("Visual-accuracy redesign — activity events are derived from GENUINE transitions only (ListingsReviewWorkspace.tsx)", () => {
  const source = read("components/listings-review/ListingsReviewWorkspace.tsx");

  it("multi-batch: tracking is per-batch (previousItemsByBatchRef keyed by batchId, completedBatchesLoggedRef a Set of batchIds) — a fresh batch's own first poll never inherits another batch's diff state, since a batch missing from the map is treated as 'no poll observed yet' for THAT batch only", () => {
    expect(source).toContain("const previousItemsByBatchRef = useRef<Map<string, Map<string, ExtensionBatchItemStatusRow>>>(new Map());");
    expect(source).toContain("const completedBatchesLoggedRef = useRef<Set<string>>(new Set());");
    expect(source).toContain("const previousItems = previousItemsByBatchRef.current.get(batchId) ?? null;");
  });

  it("the FIRST poll for a batch only seeds tracking and emits exactly one real 'sent' event (timestamped with the batch's own real createdAt) — never fabricates started/completed/failed events for state it never actually observed transitioning", () => {
    expect(source).toContain("if (previousItems === null) {");
    expect(source).toContain('tone: "sent", message: `${body.items.length} listing${body.items.length === 1 ? "" : "s"} sent to extension`, timestampIso: body.createdAt');
  });

  it("every subsequent poll only produces events for fields that actually changed relative to the previous poll — an unchanged poll (the common case) produces zero new events", () => {
    expect(source).toContain("if (isInProgress && !wasInProgress) {");
    expect(source).toContain('if (item.status === "completed" && prev.status !== "completed") {');
    expect(source).toContain('if (item.status === "failed" && prev.status !== "failed") {');
    expect(source).toContain("if (item.attemptCount > prev.attemptCount && prev.attemptCount > 0) {");
  });

  it("a still-in-progress item's fresher step detail UPDATES its existing activity event in place, rather than appending a new row every poll tick", () => {
    expect(source).toContain("updatedDetailByEventId.set(`${item.itemId}:started`, item.detail);");
    expect(source).toContain("updatedDetailByEventId.has(event.id) ? { ...event, detail: updatedDetailByEventId.get(event.id) ?? null }");
  });

  it("REGRESSION: batch completion — previously shown ONLY via the now-removed toast — now gets a real Live Activity event instead of silently disappearing, fired at most once PER BATCH via completedBatchesLoggedRef (a Set, not a single boolean — so completing Batch 1 can never suppress Batch 2's own completion event)", () => {
    expect(source).toContain('if (body.status === "completed" && !completedBatchesLoggedRef.current.has(batchId)) {');
    expect(source).toContain("completedBatchesLoggedRef.current.add(batchId);");
    expect(source).toContain("tone: \"success\", message: `Batch completed — ${savedCount} item${savedCount === 1 ? \"\" : \"s\"} saved to Vinted drafts`");
  });

  it("REGRESSION: a page load with no visible batch never touches activityEvents at all — the single owner-scoped polling effect (the only place it's ever set) early-returns when hasVisibleBatches is false", () => {
    const effectStart = source.indexOf("useEffect(() => {\n    if (!hasVisibleBatches) return;");
    expect(effectStart).toBeGreaterThan(-1);
  });

  it("every synthesised event carries its own immutable batchId, plus the batchLabel/browserLabel resolved at the moment it was created — never re-derived later from a possibly-reused display number", () => {
    expect(source).toContain('const batchLabel = `Batch ${displayNumber}`;');
    expect(source).toContain("id: `${body.batchId}:sent`, batchId, batchLabel, browserLabel,");
    expect(source).toContain("id: `${item.itemId}:completed`, batchId, batchLabel, browserLabel,");
    expect(source).toContain("id: `${item.itemId}:failed`, batchId, batchLabel, browserLabel,");
  });
});

describe("Visual-accuracy redesign — accessibility", () => {
  const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");
  const tableSource = read("components/listings-review/ListingsTable.tsx");
  const filterBarSource = read("components/listings-review/ListingsFilterBar.tsx");
  const panelSource = read("components/listings-review/ListingDetailsPanel.tsx");

  it("the summary strip and each tab expose real ARIA semantics (group/tablist/tab) rather than being plain unlabelled divs", () => {
    expect(workspaceSource).toContain('role="group" aria-label="Workspace summary"');
    expect(filterBarSource).toContain('role="tablist" aria-label="Filter by status"');
    expect(filterBarSource).toContain('aria-selected={topTab === tab.value}');
  });

  it("the header checkbox's aria-label reflects the real partial-selection count when indeterminate, not a generic label that hides the actual state", () => {
    expect(tableSource).toContain('aria-label={someSelected ? `${selectedCount} of ${rows.length} listings selected` : "Select all listings"}');
  });

  it("the search inputs use a visually-hidden (sr-only) label plus an aria-label — never a placeholder as the ONLY label", () => {
    expect(filterBarSource).toContain('<span className="label sr-only">Search</span>');
    expect(filterBarSource).toContain('aria-label="Search listings"');
  });

  it("previous/next/close inspector controls each carry a real aria-label, and thumbnail buttons expose aria-pressed for the active state", () => {
    expect(panelSource).toContain('aria-label="Previous listing"');
    expect(panelSource).toContain('aria-label="Next listing"');
    expect(panelSource).toContain('aria-label="Close"');
    expect(panelSource).toContain("aria-pressed={photoId === mainPhotoId}");
  });
});

describe("Visual-accuracy redesign — responsive structure", () => {
  const css = read("app/globals.css");

  it("1024-1439px: a slightly narrower inspector column, Cost/Price/Profit stay visible (only their width tightens, never truncating)", () => {
    expect(css).toContain("@media (max-width: 1439px) {");
    expect(css).toContain(".lr-workspace { grid-template-columns: minmax(0, 1fr) minmax(260px, 27%); }");
  });

  it("below 1024px: the inspector/activity column stacks beneath the table", () => {
    expect(css).toMatch(/@media \(max-width: 1023px\) \{\s*\.lr-workspace \{ grid-template-columns: 1fr; \}/);
  });

  it("REGRESSION: the 900px toast-clearance override is gone along with the toast stack itself — the filters-popover override at the same breakpoint is untouched", () => {
    expect(css).not.toMatch(/\.lr-toast-stack \{ right: 12px; bottom: 82px; \}/);
    expect(css).toMatch(/@media \(max-width: 900px\) \{\s*\.lr-filters-popover \{ left: auto; right: 0; max-width: calc\(100vw - 32px\); \}/);
  });
});

describe("Visual-accuracy redesign — draft-only safety, no AI usage, no unrelated logic changed", () => {
  const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");
  const extensionRouteSource = read("app/api/extension/batch/items/[itemId]/result/route.ts");
  const serviceWorkerSource = read("vinted-draft-queue-extension/service-worker.js");

  it("REGRESSION: no publish/list-on-Vinted action exists anywhere in this redesign — the safety badge is still shown, and the extension is still only ever described as drafts-only", () => {
    expect(workspaceSource).not.toMatch(/<button[^>]*>\s*Publish/i);
    expect(workspaceSource).not.toMatch(/publish.{0,20}vinted|list.{0,10}on vinted/i);
    expect(workspaceSource).toContain("Drafts only — never publishes");
  });

  it("REGRESSION: the extension change is reporting-only — postResultToApp forwards currentStep/detail alongside the existing fields, but no form-filling/Save Draft step logic in form-steps.js was touched", () => {
    expect(serviceWorkerSource).toContain("currentStep: extra.currentStep ?? null, detail: extra.detail ?? null,");
  });

  it("REGRESSION: no AI call was added anywhere in this redesign — the result route only ever persists already-computed step text, never calls an AI model", () => {
    expect(extensionRouteSource).not.toMatch(/anthropic|claude|generateListing|callClaude/i);
  });

  it("current_step/step_detail are cleared on a fresh attempt (preparing) and finalised to null on every terminal status — a completed or retried item can never keep showing a stale 'Uploading photo…' line", () => {
    expect(extensionRouteSource).toContain("patchBody.current_step = isTerminalItemStatus(body.status) ? null : (body.currentStep ?? null);");
    expect(extensionRouteSource).toContain("patchBody.step_detail = isTerminalItemStatus(body.status) ? null : (body.detail ?? null);");
  });

  it("REGRESSION: the [batchId] GET route and the extension result POST route both gracefully degrade if current_step/step_detail don't exist yet (pre-migration), rather than 500ing and blocking all real status reporting", () => {
    const batchIdRouteSource = read("app/api/listing-studio/extension-batches/[batchId]/route.ts");
    expect(batchIdRouteSource).toContain("/column .* does not exist|schema cache/i");
    expect(extensionRouteSource).toContain("/column .* does not exist|schema cache/i");
  });
});

describe("Visual-accuracy redesign — historical workflow status survives reload/restart (rpc/listing_studio_latest_extension_status)", () => {
  const routeSource = read("app/api/listing-studio/listings-review/route.ts");
  const sqlSource = read("supabase-listing-studio.sql");

  it("the listings-review route calls the new RPC exactly once per page load (not per listing) and attaches the result per draft", () => {
    expect(routeSource).toContain('supabaseRequest("rpc/listing_studio_latest_extension_status"');
    expect(routeSource).toContain("body: JSON.stringify({ p_owner_id: user.id })");
    expect(routeSource).toContain("extension_status: extensionStatusByDraftId.get(draft.id) ?? null,");
  });

  it("the RPC is owner-scoped, excludes cancelled items, uses fully-qualified table names, and is deterministic via a real timestamp ordering with a stable final tie-breaker", () => {
    const fnSource = sqlSource.slice(sqlSource.indexOf("create or replace function public.listing_studio_latest_extension_status"), sqlSource.indexOf("$$;\n\n-- Milestone 7 (Vinted category catalogue sync) — applies"));
    expect(fnSource).toContain("where b.owner_id = p_owner_id");
    expect(fnSource).toContain("and bi.status <> 'cancelled'");
    expect(fnSource).toContain("from public.vinted_extension_batch_items bi");
    expect(fnSource).toContain("join public.vinted_extension_batches b on b.id = bi.batch_id");
    expect(fnSource).toContain("order by bi.draft_id, greatest(bi.completed_at, bi.started_at, b.created_at) desc, b.created_at desc, bi.id desc;");
  });

  it("the function is revoked from public/anon/authenticated, matching the exact existing security convention for every other listing_studio_* RPC", () => {
    expect(sqlSource).toContain("revoke all on function public.listing_studio_latest_extension_status(uuid) from public;");
    expect(sqlSource).toContain("revoke all on function public.listing_studio_latest_extension_status(uuid) from anon;");
    expect(sqlSource).toContain("revoke all on function public.listing_studio_latest_extension_status(uuid) from authenticated;");
  });

  it("the two new columns are additive (nullable, no default that could silently misrepresent old rows) via the same 'add column if not exists' idiom already used throughout this file", () => {
    expect(sqlSource).toContain("alter table public.vinted_extension_batch_items add column if not exists current_step text;");
    expect(sqlSource).toContain("alter table public.vinted_extension_batch_items add column if not exists step_detail text;");
  });
});

describe("Correction pass, generalised for multi-batch — a genuinely gone batch clears ONLY its own stale UI state rather than displaying it forever", () => {
  const source = read("components/listings-review/ListingsReviewWorkspace.tsx");

  it("a 404 for one batch during a poll cycle drops only that batch's id from visibleBatchIds/batchStatusById/pairingCodeById — every other tracked batch is left completely untouched, never leaving a stale pairing code or 'processing' box with no way to recover", () => {
    const pollFnStart = source.indexOf("async function poll() {");
    const pollFnEnd = source.indexOf("\n    poll();", pollFnStart);
    const pollFn = source.slice(pollFnStart, pollFnEnd);
    expect(pollFn).toContain("if (result.status === 404) {");
    expect(pollFn).toContain("setVisibleBatchIds(current => { const next = new Set(current); next.delete(result.id); return next; });");
    expect(pollFn).toContain("setBatchStatusById(current => { const next = new Map(current); next.delete(result.id); return next; });");
    expect(pollFn).toContain("setPairingCodeById(current => { const next = new Map(current); next.delete(result.id); return next; });");
  });
});

describe("Correction pass, generalised for multi-batch — resume tracking after a reload (root-cause fix)", () => {
  const source = read("components/listings-review/ListingsReviewWorkspace.tsx");

  it("on mount, resumes EVERY visible batch from an earlier session (not just one) — populates visibleBatchIds and batchMetaById from every {batchId, displayNumber} entry the resume endpoint returns", () => {
    expect(source).toContain('fetch("/api/listing-studio/extension-batches")');
    expect(source).toContain("const body = await response.json() as { batchIds: { batchId: string; displayNumber: number }[]; recoverable?: RecoverableBatchInfo[] };");
    expect(source).toContain("for (const entry of body.batchIds) next.add(entry.batchId);");
    expect(source).toContain("for (const entry of body.batchIds) if (!next.has(entry.batchId)) next.set(entry.batchId, { displayNumber: entry.displayNumber, browserLabel: null });");
  });

  it("runs exactly once on mount (empty dependency array) — a same-session batch creation (which only ever ADDS to visibleBatchIds, never clears it first) can never be clobbered by this effect running after it", () => {
    const effectIndex = source.indexOf("useEffect(() => {\n    let cancelled = false;\n    (async () => {\n      try {\n        const response = await fetch(\"/api/listing-studio/extension-batches\");");
    expect(effectIndex).toBeGreaterThan(-1);
    const effectBlock = source.slice(effectIndex, source.indexOf("}, []);", effectIndex) + 8);
    expect(effectBlock).toContain('fetch("/api/listing-studio/extension-batches")');
  });
});

describe("Correction pass — compact inspector prev/next/close", () => {
  const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");
  const panelSource = read("components/listings-review/ListingDetailsPanel.tsx");

  it("the panel header renders Previous/Next/Close controls, disabled at the real ends of the filtered list", () => {
    expect(panelSource).toContain('disabled={!hasPrevious} onClick={onPrevious} aria-label="Previous listing"');
    expect(panelSource).toContain('disabled={!hasNext} onClick={onNext} aria-label="Next listing"');
    expect(panelSource).toContain('onClick={onClose} aria-label="Close"');
    expect(panelSource).toContain("const hasPrevious = position !== null && position.index > 0;");
    expect(panelSource).toContain("const hasNext = position !== null && position.index < position.total - 1;");
  });

  it("the workspace navigates within the real filtered row order — never a hardcoded/unfiltered list", () => {
    expect(workspaceSource).toContain("setSelectedListingId(filteredRows[selectedListingPosition.index - 1].id);");
    expect(workspaceSource).toContain("setSelectedListingId(filteredRows[selectedListingPosition.index + 1].id);");
    expect(workspaceSource).toContain("onClose={closeInspector}");
  });

  it("the status is ALWAYS shown (readiness fallback when there's no workflow status yet) — not only once a listing has been sent", () => {
    expect(panelSource).toContain("const displayLabel = listing.workflowStatus ? WORKFLOW_STATUS_LABELS[listing.workflowStatus] : READINESS_LABELS[listing.status];");
    expect(panelSource).toContain('pulse={listing.workflowStatus === "in_progress"}');
  });

  it("the title is capped at 2 lines — cannot silently grow the compact card", () => {
    const css = read("app/globals.css");
    expect(css).toContain("-webkit-line-clamp: 2; -webkit-box-orient: vertical;");
  });
});

describe("Polish pass — category gets its own full-width, wrapping row (fixes real horizontal overflow)", () => {
  const panelSource = read("components/listings-review/ListingDetailsPanel.tsx");
  const css = read("app/globals.css");

  it("REGRESSION: Category is no longer inside the narrow 2-column metadata grid — it has its own dedicated wrapper, full-width beneath Brand/Condition/Colour(s)", () => {
    const fieldsIndex = panelSource.indexOf('<dl className="lr-inspector-fields">');
    const fieldsBlock = panelSource.slice(fieldsIndex, panelSource.indexOf("</dl>", fieldsIndex));
    expect(fieldsIndex).toBeGreaterThan(-1);
    expect(fieldsBlock).toContain("<dt>Brand</dt>");
    expect(fieldsBlock).toContain("<dt>Condition</dt>");
    expect(fieldsBlock).toContain("<dt>Colour");
    expect(fieldsBlock).not.toContain("<dt>Category</dt>");
    expect(panelSource).toContain('<dl className="lr-inspector-category">');
    expect(panelSource).toContain("{listing.vintedCategoryPath || listing.productType || \"Not set\"}");
    expect(panelSource).not.toContain("lr-inspector-fields-wrap");
  });

  it("shows the FULL category path, never truncated to only the final segment", () => {
    expect(panelSource).toContain("listing.vintedCategoryPath || listing.productType");
    expect(panelSource).not.toMatch(/vintedCategoryPath\.split/);
  });

  it("the category wrapper uses the required containment rules — wraps naturally, never ellipsised, contained within the card", () => {
    expect(css).toContain(".lr-inspector-category { margin: 10px 0 0; min-width: 0; max-width: 100%; }");
    expect(css).toContain(".lr-inspector-category dd { margin: 3px 0 0; min-width: 0; max-width: 100%; color: var(--lr-text); font-size: 11px; font-weight: 600; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; word-break: normal; }");
    // Never solved with an ellipsis for this field.
    expect(css).not.toMatch(/\.lr-inspector-category dd \{[^}]*text-overflow:\s*ellipsis/);
  });

  it("REGRESSION: every 2-column metadata grid item also gets min-width: 0 — CSS grid items default to min-width: auto, which is the actual root cause of the original overflow (a long unbreakable word could force a 1fr column wider than its fair share, pushing the whole card into horizontal overflow)", () => {
    expect(css).toContain(".lr-inspector-fields > div { min-width: 0; }");
  });

  it("the inspector's own outer container is defensively contained too — min-width: 0, max-width: 100%, overflow-x: hidden — so the card itself can never gain a horizontal scrollbar", () => {
    expect(css).toContain(".lr-inspector { position: sticky; top: 12px; display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--lr-border); border-radius: 10px; background: var(--lr-surface-raised); min-width: 0; max-width: 100%; overflow-x: hidden; }");
  });

  it("label styling is consistent with the other metadata fields (same muted colour, same uppercase letter-spacing convention)", () => {
    expect(css).toContain(".lr-inspector-category dt { color: var(--lr-muted); font-size: 8.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }");
  });
});

describe("Correction pass — contextual send/resend (reuses the existing batch-creation path, never a new one)", () => {
  const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");
  const panelSource = read("components/listings-review/ListingDetailsPanel.tsx");
  const tableSource = read("components/listings-review/ListingsTable.tsx");

  it("handleSendToExtension accepts an optional idsOverride so the inspector AND the table row overflow menu can reuse it for a single listing — every existing call site (no argument) is unchanged", () => {
    expect(workspaceSource).toContain("async function handleSendToExtension(idsOverride?: string[]) {");
    expect(workspaceSource).toContain("const ids = idsOverride ?? [...bulkSelectedIds];");
    expect(workspaceSource).toContain("onSendToExtension={id => handleSendToExtension([id])}");
    expect(tableSource).toContain("onSendToExtension");
  });

  it("only offered when genuinely sendable (not needs_review) and not already mid-workflow; relabels to 'Resend' after a failure — no separate retry endpoint invented", () => {
    expect(panelSource).toContain('const canSend = listing.status !== "needs_review" && (listing.workflowStatus === null || listing.workflowStatus === "failed");');
    expect(panelSource).toMatch(/listing\.workflowStatus === "failed" \? "Resend to extension" : "Send to extension"/);
  });
});

describe("Visual-accuracy redesign — dense table fits without horizontal scroll (fixed column-width budget)", () => {
  const css = read("app/globals.css");

  it("table-layout: fixed with an explicit width on every column except Listing (which absorbs the remainder); every OTHER column is sized to its own genuine content need, not padded for balance", () => {
    expect(css).toContain(".lr-table { width: 100%; table-layout: fixed; border-collapse: collapse; }");
    expect(css).toContain(".lr-table th:nth-child(1), .lr-table td:nth-child(1) { width: 32px; text-align: center; }");
    expect(css).toContain(".lr-table th:nth-child(2), .lr-table td:nth-child(2) { width: 72px; }");
    expect(css).toContain(".lr-table th:nth-child(4), .lr-table td:nth-child(4) { width: 44px; }");
    expect(css).toContain(".lr-table th:nth-child(8), .lr-table td:nth-child(8) { width: 148px; }");
    expect(css).toContain(".lr-table th:nth-child(9), .lr-table td:nth-child(9) { width: 44px; text-align: center; }");
    expect(css).not.toMatch(/td:nth-child\(3\)\s*\{\s*width/);
  });

  it("REGRESSION: the actions column (44px) is wide enough for its own 26px trigger button plus real padding — the previous 34px width was 6px narrower than the trigger itself, the exact confirmed cause of the row menu being clipped at the right edge", () => {
    expect(css).toContain(".lr-table th:nth-child(9), .lr-table td:nth-child(9) { width: 44px; text-align: center; }");
    expect(css).toContain(".overflow-menu-trigger { min-height: 26px; min-width: 26px;");
  });

  it("the photo column (72px) exactly fits its own 52px thumbnail plus the table's 2x10px cell padding — the previous 68px width was 4px too narrow", () => {
    expect(css).toContain(".lr-table th:nth-child(2), .lr-table td:nth-child(2) { width: 72px; }");
    expect(css).toContain(".lr-cover-thumb { width: 52px; height: 52px;");
  });

  it("a long generated title gets an accessible native tooltip showing the full text on truncation", () => {
    const tableSource = read("components/listings-review/ListingsTable.tsx");
    expect(tableSource).toContain('<span className="lr-title-text" title={row.generatedTitle || "Untitled listing"}>{row.generatedTitle || "Untitled listing"}</span>');
  });

  it("row hover is clearly visible, distinct from the selected-row treatment", () => {
    expect(css).toContain(".lr-row:hover { background: var(--lr-surface-raised); }");
    expect(css).toContain(".lr-row-active, .lr-row-active:hover { background: var(--lr-violet-soft); }");
  });
});

describe("Multi-batch support — batch box grid replaces the old single compact pairing strip (components/listings-review/ExtensionBatchGrid.tsx)", () => {
  const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");
  const gridSource = read("components/listings-review/ExtensionBatchGrid.tsx");

  it("the workspace renders ONE ExtensionBatchGrid fed every visible batch's view model — never a per-batch strip repeated by hand in the workspace's own JSX", () => {
    expect(workspaceSource).toContain("import ExtensionBatchGrid, { type BatchBoxViewModel } from \"./ExtensionBatchGrid\";");
    expect(workspaceSource).toContain("<ExtensionBatchGrid");
    expect(workspaceSource).toContain("batches={batchBoxViewModels}");
  });

  it("each box has 4 distinct states: preparing (no poll yet), pre-claim (code + hint + expiry + Cancel), claimed-in-progress (minimal, no code), terminal (× dismiss + summary, no Cancel)", () => {
    expect(gridSource).toContain("Preparing batch…");
    expect(gridSource).toContain("Waiting for pairing");
    expect(gridSource).toContain("Processing —");
    expect(gridSource).toContain("terminalSummary(box)");
  });

  // REGRESSION (live-caught 2026-08-11, still true per-box after the
  // multi-batch rewrite): a batch cancelled before it was ever claimed has
  // claimedAt stuck at null forever — terminal status must still decide
  // the box's branch before "waiting for pairing"/"claimed", or a box
  // would be left showing a dead pairing code indefinitely instead of
  // collapsing to its terminal summary + × state.
  it("REGRESSION: a box's terminal branch is independent of (checked ahead of) its pairing/claimed branches, so a batch cancelled pre-claim still renders its terminal summary, not a dead pairing code", () => {
    expect(gridSource).toContain("const isTerminal = !isPending && isBatchStatusTerminal(box.status);");
    const bodyIndex = gridSource.indexOf("return <div className={`lr-batch-box");
    const isTerminalJsxIndex = gridSource.indexOf("{isTerminal && <p className=\"lr-batch-box-status\">{terminalSummary(box)}</p>}");
    expect(bodyIndex).toBeGreaterThan(-1);
    expect(isTerminalJsxIndex).toBeGreaterThan(bodyIndex);
  });

  it("terminal summaries are correctly pluralised and distinguish completed-with-failures from a clean completion, never collapsing both into the same generic wording", () => {
    expect(gridSource).toContain('function pluralize(count: number, noun: string): string {');
    expect(gridSource).toMatch(/if \(box\.failedCount === 0\) return `Completed — \$\{pluralize\(box\.completedCount, "listing"\)\} saved to Vinted drafts\.`;/);
    expect(gridSource).toContain('return `Completed — ${box.completedCount} of ${box.listingCount} saved, ${pluralize(box.failedCount, "failed")}.`;');
  });

  it("boxes are laid out as a two-column grid (never pagination/arrows), collapsing to one column on narrow screens, using the same existing card/border/spacing/type language as every other card on this page — not a copy of unrelated navigation/summary-card styling", () => {
    const css = read("app/globals.css");
    expect(css).toContain(".lr-batch-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }");
    expect(css).toMatch(/@media \(max-width: 1023px\) \{[\s\S]*?\.lr-batch-grid \{ grid-template-columns: 1fr; \}/);
    expect(css).toContain(".lr-batch-box { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--lr-border); border-radius: 8px; background: var(--lr-surface-raised);");
  });

  it("renders nothing at all once every batch has been dismissed — no empty grid element left behind, matching the old strip's own render-nothing-when-empty behaviour", () => {
    expect(gridSource).toContain("if (batches.length === 0) return null;");
  });

  it("does not repeat the permanent safety badge, which now lives only in the page's own top line", () => {
    expect(gridSource).not.toContain("Drafts only");
    expect(workspaceSource).not.toMatch(/lr-batch-grid[^>]*>\s*<span className="lr-safety-badge"/);
  });
});

describe("Visual-accuracy redesign — bulk-bar structural fix (lives inside the table column, never a viewport-fixed overlay)", () => {
  const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");
  const css = read("app/globals.css");

  it("the bulk bar is the LAST child of .lr-table-column, sibling to (not overlapping) .lr-rail — structurally distinct columns, not two elements sharing viewport coordinates", () => {
    const columnStart = workspaceSource.indexOf('<div className="lr-table-column">');
    const columnEnd = workspaceSource.indexOf("</div>\n      <div className=\"lr-rail\">");
    expect(columnStart).toBeGreaterThan(-1);
    expect(columnEnd).toBeGreaterThan(columnStart);
    const columnBlock = workspaceSource.slice(columnStart, columnEnd);
    expect(columnBlock).toContain("<ListingsTable");
    expect(columnBlock).toContain('<div className="lr-bulk-bar"');
  });

  it("REGRESSION: the bulk bar is position:sticky relative to its own column (bottom:0), never position:fixed spanning the whole viewport — this was the exact cause of the previous 'malformed control bleeding through the bar' defect (a fixed overlay with only a guessed padding-bottom reservation, floating over whatever content happened to scroll underneath it)", () => {
    expect(css).toContain(".lr-bulk-bar { position: sticky; bottom: 0;");
    expect(css).not.toMatch(/\.lr-bulk-bar \{[^}]*position: fixed/);
  });

  it("Assign categories/Mark ready/Export live inside one OverflowMenu — Delete and Send stay the only two always-visible primary actions, matching the reference hierarchy", () => {
    expect(workspaceSource).toContain('<OverflowMenu label="More bulk actions" items={[');
    expect(workspaceSource).toContain("onClick: handleBulkAssignCategories");
    expect(workspaceSource).toContain("onClick: handleBulkMarkReady");
    expect(workspaceSource).toContain("onClick: handleExport");
  });
});

describe("Visual-accuracy redesign — mobile card list (a real alternate layout, not a reflowed table)", () => {
  const tableSource = read("components/listings-review/ListingsTable.tsx");
  const css = read("app/globals.css");

  it("renders both the table and a separate <ul> card list, sharing the same rows/handlers — CSS (not JS) decides which is visible", () => {
    expect(tableSource).toContain('<ul className="lr-card-list">');
    expect(tableSource).toContain('pulse={row.workflowStatus === "in_progress"}');
  });

  it("hidden/shown via a dedicated 620px block positioned after its own base rules — the table hides, the card list shows, matching this codebase's established phone breakpoint", () => {
    expect(css).toMatch(/@media \(max-width: 620px\) \{\s*\.lr-table-scroll \{ display: none; \}\s*\.lr-card-list \{ display: flex; \}/);
  });

  it("cards keep 44px-minimum tap targets for checkbox and row-menu areas", () => {
    expect(css).toContain(".lr-card-checkbox { display: flex; align-items: center; min-height: 44px; }");
    expect(css).toContain(".lr-card-actions { display: flex; align-items: center; min-height: 44px; }");
  });
});

describe("Production-polish pass — components/listing-studio/OverflowMenu.tsx: portal-rendered, viewport-aware, keyboard-accessible", () => {
  const source = read("components/listing-studio/OverflowMenu.tsx");

  it("renders the dropdown in a portal attached to document.body — never inside whatever scrollable container the trigger lives in", () => {
    expect(source).toContain('import { createPortal } from "react-dom";');
    expect(source).toContain("createPortal(");
    expect(source).toContain("document.body,");
  });

  it("REGRESSION: this is the fix for the previously invisible/clipped row menu — an ancestor with overflow-x: auto (the Listings Review table's own scroll wrapper) forces overflow-y to also compute as clipping per the CSS Overflow spec, silently hiding an absolutely-positioned dropdown that extended past the row's own bounds", () => {
    expect(source).toMatch(/overflow-x: auto[\s\S]*forces `overflow-y`|forces `overflow-y`[\s\S]*overflow-x: auto/);
  });

  it("positions the menu relative to the trigger's own getBoundingClientRect(), and flips above the trigger when there's insufficient room below", () => {
    expect(source).toContain("triggerRef.current.getBoundingClientRect()");
    expect(source).toContain("const spaceBelow = window.innerHeight - rect.bottom;");
    expect(source).toContain("openUpward");
  });

  it("clamps the menu so it can never extend past the viewport's left/right edge", () => {
    expect(source).toContain("Math.min(Math.max(rect.right - MENU_WIDTH, VIEWPORT_MARGIN), window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN)");
  });

  it("closes on Escape and on an outside click — checked against BOTH the trigger and the portaled menu, since a portal is a separate DOM subtree from its trigger", () => {
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("containerRef.current?.contains(event.target as Node)");
    expect(source).toContain("menuRef.current?.contains(target)");
  });

  it("Escape and item-selection both return focus to the trigger", () => {
    expect(source).toContain('setOpen(false); triggerRef.current?.focus(); return;');
    expect(source).toContain("setOpen(false); triggerRef.current?.focus(); item.onClick();");
  });

  it("supports ArrowUp/ArrowDown keyboard navigation between enabled items, and auto-focuses the first enabled item on open", () => {
    expect(source).toContain('event.key !== "ArrowDown" && event.key !== "ArrowUp"');
    expect(source).toContain("const firstEnabled = itemRefs.current.find(el => el && !el.disabled);");
  });

  it("repositions on scroll/resize so the menu never visually detaches from its trigger while the page moves underneath it", () => {
    expect(source).toContain('window.addEventListener("scroll", handleReflow, true);');
    expect(source).toContain('window.addEventListener("resize", handleReflow);');
  });

  it("every item is a real, keyboard-reachable menuitem button", () => {
    expect(source).toContain('role="menuitem"');
    expect(source).toContain('aria-haspopup="menu"');
  });
});

describe("Production-polish pass — app/globals.css: overlay layer system and menu hover/focus states", () => {
  const css = read("app/globals.css");

  it("documents a small, intentional overlay layer system (base/sticky/dropdown/dialog/toast), not ad hoc z-index values", () => {
    expect(css).toMatch(/base content\s*—\s*auto/);
    expect(css).toMatch(/dropdowns\/tooltips\s*—\s*70/);
    expect(css).toMatch(/dialogs\s*—\s*100/);
    expect(css).toMatch(/toasts\s*—\s*200\+/);
  });

  it("the portaled menu's z-index (70) sits strictly between sticky controls (<=60) and dialogs (100), so it always wins over a bulk-action bar or the sidebar/nav but never covers a modal dialog", () => {
    expect(css).toContain(".overflow-menu-list-portal { z-index: 70;");
  });

  it("menu items have both a hover state and a visible focus-visible state (never focus-invisible)", () => {
    expect(css).toContain(".overflow-menu-item:hover:not(:disabled) { background: var(--surface-2); }");
    expect(css).toContain(".overflow-menu-item:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; background: var(--surface-2); }");
  });

  it("the menu's entrance animation respects prefers-reduced-motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.overflow-menu-list-portal \{ animation: none; \}/);
  });
});

describe("Production-polish pass — inspector auto-selects the first visible listing (ListingsReviewWorkspace.tsx)", () => {
  const source = read("components/listings-review/ListingsReviewWorkspace.tsx");

  it("auto-selects the first filtered row whenever nothing is selected (or the current selection is no longer visible), unless the inspector was explicitly closed", () => {
    expect(source).toContain("const [inspectorClosed, setInspectorClosed] = useState(false);");
    expect(source).toContain("if (inspectorClosed) return;");
    expect(source).toContain("if (filteredRows.length === 0) return;");
    expect(source).toContain("const stillVisible = selectedListingId !== null && filteredRows.some(row => row.id === selectedListingId);");
    expect(source).toContain("if (!stillVisible) setSelectedListingId(filteredRows[0].id);");
  });

  it("REGRESSION: this is inspector focus ONLY — the auto-select effect never touches bulkSelectedIds, never calls a mark-ready/assign-category handler, and never issues a network request", () => {
    const effectIndex = source.indexOf("if (inspectorClosed) return;");
    const effectBlock = source.slice(source.lastIndexOf("useEffect(() => {", effectIndex), source.indexOf("}, [filteredRows, selectedListingId, inspectorClosed]);") + 10);
    expect(effectBlock).not.toContain("bulkSelectedIds");
    expect(effectBlock).not.toContain("fetch(");
  });

  it("a row click clears the explicit-close flag so auto-select resumes correctly on the next filter change; Close sets it so an intentional dismissal is never immediately re-filled", () => {
    expect(source).toContain("const selectListing = useCallback((id: string) => {\n    setInspectorClosed(false);\n    setSelectedListingId(id);\n  }, []);");
    expect(source).toContain("const closeInspector = useCallback(() => {\n    setInspectorClosed(true);\n    setSelectedListingId(null);\n  }, []);");
    expect(source).toContain("onSelectListing={selectListing}");
  });

  it("checkbox clicks are independent of inspector selection — the checkbox's own onClick stops propagation before it ever reaches the row's onSelectListing handler", () => {
    const tableSource = read("components/listings-review/ListingsTable.tsx");
    expect(tableSource).toContain('<td className="lr-checkbox-cell" onClick={event => event.stopPropagation()}>');
  });
});

describe("Production-polish pass, extended for multi-batch — pairing display: copy button, monospace code, self-clearing confirmation, PER BATCH", () => {
  const source = read("components/listings-review/ListingsReviewWorkspace.tsx");
  const gridSource = read("components/listings-review/ExtensionBatchGrid.tsx");
  const css = read("app/globals.css");

  it("copies a SPECIFIC batch's real pairing code to the clipboard via the standard Clipboard API, keyed by its immutable batch id", () => {
    expect(source).toContain("const handleCopyPairingCode = useCallback(async (batchId: string) => {");
    expect(source).toContain("const code = pairingCodeById.get(batchId);");
    expect(source).toContain("await navigator.clipboard.writeText(code);");
  });

  it("shows a short, self-clearing 'Copied' confirmation scoped to only the batch whose Copy button was just clicked — copying Batch 1's code never shows 'Copied' on Batch 2's box", () => {
    expect(source).toContain("setCodeCopiedBatchId(batchId);");
    expect(source).toContain("window.setTimeout(() => setCodeCopiedBatchId(current => (current === batchId ? null : current)), 1600);");
    expect(gridSource).toContain('{box.codeCopied ? "Copied" : "Copy"}');
  });

  it("each box computes its own codeCopied flag by comparing its own batchId against codeCopiedBatchId — never a single shared boolean that could show 'Copied' on the wrong box", () => {
    expect(source).toContain("const codeCopied = codeCopiedBatchId === id;");
  });

  it("resets codeCopiedBatchId whenever a fresh batch is created, so a stale 'Copied' can never survive into a new batch", () => {
    expect(source).toContain("setCodeCopiedBatchId(null);");
  });

  it("the code uses a real, explicit monospace font stack and never looks like a plain native text selection", () => {
    expect(css).toContain('.lr-pairing-code { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;');
    expect(css).toContain("user-select: all;");
  });

  it("existing drafts-only safety wording (page-level, permanent) and single-use pairing behaviour wording (per box, while waiting) are both retained", () => {
    expect(source).toContain("Drafts only — never publishes");
    expect(gridSource).toContain("single use");
  });
});

describe("Production-polish pass — Live Activity empty state stays compact (small icon + one line, no tutorial copy)", () => {
  const source = read("components/listings-review/DraftActivityPanel.tsx");
  const css = read("app/globals.css");

  it("shows a small neutral icon plus exactly the required text, and nothing else", () => {
    expect(source).toContain("No extension activity yet.");
    expect(source).toMatch(/<svg aria-hidden="true"[^>]*>[\s\S]*<\/svg>\s*<p>No extension activity yet\.<\/p>/);
  });

  it("REGRESSION: no tutorial/explanatory copy was added — the empty state is still exactly one short line", () => {
    const emptyBlockStart = source.indexOf('<div className="lr-activity-empty">');
    const emptyBlockEnd = source.indexOf("</div>", emptyBlockStart);
    const emptyBlock = source.slice(emptyBlockStart, emptyBlockEnd);
    expect((emptyBlock.match(/<p>/g) ?? []).length).toBe(1);
  });

  it("stays visually compact — a small icon size, no large padding", () => {
    expect(css).toContain(".lr-activity-empty { display: flex; padding: 10px 0; align-items: center; gap: 8px; color: var(--lr-muted); }");
  });
});

describe("Production-polish pass — workflow status alignment (dot/label centred, secondary line aligned under the LABEL not the dot)", () => {
  const css = read("app/globals.css");

  it("the secondary line's left offset exactly equals the dot's width + gap, so it visually aligns under the label text rather than the dot", () => {
    expect(css).toContain(".lr-workflow-dot { width: 8px; height: 8px; border-radius: 999px; flex: 0 0 8px;");
    expect(css).toContain(".lr-workflow-status-row { display: inline-flex; align-items: center; gap: 7px; min-width: 0; }");
    expect(css).toContain(".lr-workflow-secondary { overflow: hidden; margin-left: 15px;");
  });

  it("REGRESSION: no square/pill/badge backplate was ever reintroduced behind the dot — it remains a bare circle", () => {
    expect(css).toContain("border-radius: 999px;");
    expect(css).not.toMatch(/\.lr-workflow-dot\s*\{[^}]*border-radius:\s*(?:[2-9]|1[0-9])px/);
  });

  it("the SAME WorkflowStatus component (and therefore the SAME alignment) is used by both the table and the inspector — never a second implementation", () => {
    const tableSource = read("components/listings-review/ListingsTable.tsx");
    const panelSource = read("components/listings-review/ListingDetailsPanel.tsx");
    expect(tableSource).toContain('import { WorkflowStatus } from "./WorkflowStatus";');
    expect(panelSource).toContain('import { WorkflowStatus } from "./WorkflowStatus";');
  });
});

describe("REGRESSION (superseded) — the malformed green/blue floating control was a toast class-name collision (.lr-toast-progress meaning two different things); this whole class of bug is now categorically impossible", () => {
  const css = read("app/globals.css");

  it("the entire toast system that carried the collision is gone — there is no .lr-toast-progress, .lr-toast-dismiss-bar, or any other .lr-toast-* rule left to ever collide again", () => {
    expect(css).not.toMatch(/\.lr-toast[a-z-]*\s*\{/);
  });
});

describe("Multi-batch support — components/listings-review/ExtensionBatchGrid.tsx: per-box detail", () => {
  const source = read("components/listings-review/ExtensionBatchGrid.tsx");

  it("is memo()'d and takes only already-resolved view models — never fetches, polls, or holds its own batch state", () => {
    expect(source).toContain("export default memo(ExtensionBatchGrid);");
    expect(source).not.toMatch(/fetch\(/);
    expect(source).not.toMatch(/useState|useEffect/);
  });

  it("shows the browser/client label as a small badge only when known — never a fabricated one when the batch hasn't been claimed yet", () => {
    expect(source).toContain('{box.browserLabel && <span className="lr-batch-box-browser">{box.browserLabel}</span>}');
  });

  it("each box's header carries a real aria-label naming its own display number — screen readers can distinguish boxes without relying on visual position alone", () => {
    expect(source).toContain('role="group" aria-label={`Batch ${box.displayNumber}`}');
  });

  it("the dismiss control is only rendered for a terminal box, carries a batch-specific aria-label, and calls onDismissBox with THIS box's own immutable batchId", () => {
    expect(source).toContain('{isTerminal && <button type="button" className="lr-batch-box-dismiss" aria-label={`Dismiss Batch ${box.displayNumber} box`} onClick={() => onDismissBox(box.batchId)}>');
  });

  it("Cancel is offered in both the waiting-for-pairing and claimed/in-progress states, always scoped to this box's own batchId — never a generic cancel-current-batch action", () => {
    const pairingCancel = source.slice(source.indexOf("isWaitingForPairing && <div"), source.indexOf("isClaimed && <div"));
    const claimedCancel = source.slice(source.indexOf("isClaimed && <div"), source.indexOf("isTerminal && <p"));
    expect(pairingCancel).toContain("onClick={() => onCancel(box.batchId)}>Cancel</button>");
    expect(claimedCancel).toContain("onClick={() => onCancel(box.batchId)}>Cancel batch</button>");
  });

  it("Cancel is never offered once a box is terminal — a finished batch has nothing left to cancel", () => {
    const terminalBlock = source.slice(source.indexOf('{isTerminal && <p className="lr-batch-box-status">'));
    expect(terminalBlock).not.toContain("onCancel(box.batchId)");
  });

  it("a cancelled batch's terminal summary reports both what completed before cancelling AND what was left unfinished, never just one or the other", () => {
    expect(source).toContain("const parts = [`${box.completedCount} completed before cancelling`];");
    expect(source).toContain("if (unfinished > 0) parts.push(`${unfinished} not finished`);");
  });

  it("an expired (never-claimed) batch gets its own distinct terminal wording, not lumped in with cancelled", () => {
    expect(source).toContain('if (box.status === "expired") return "Expired — this batch was never claimed by the extension.";');
  });
});

describe("Multi-batch support — components/listings-review/DraftActivityPanel.tsx: All/Batch filters + per-batch dismiss", () => {
  const source = read("components/listings-review/DraftActivityPanel.tsx");

  it("accepts filters/selectedFilter/onSelectFilter/onDismissActivity as props — the panel itself only renders what the parent already computed, never deriving the batch list itself", () => {
    expect(source).toContain("filters: ActivityBatchFilter[];");
    expect(source).toContain("selectedFilter: string;");
    expect(source).toContain("onSelectFilter: (filter: string) => void;");
    expect(source).toContain("onDismissActivity: (batchId: string) => void;");
  });

  it("All is always the first filter button and is not itself part of the filters prop — selecting it never depends on any specific batchId existing", () => {
    expect(source).toContain('onClick={() => onSelectFilter("all")}>All</button>');
  });

  it("renders one filter button per batch in filters, using the label the parent already resolved — never inventing its own label text from a raw batchId", () => {
    expect(source).toContain("{filters.map(f => <button key={f.batchId}");
    expect(source).toContain("onClick={() => onSelectFilter(f.batchId)}>{f.label}</button>");
  });

  it("the filter row is entirely absent when there are no batches yet — never an empty All-only row with nothing to filter", () => {
    expect(source).toContain('{filters.length > 0 && <div className="lr-activity-filters"');
  });

  it("the Dismiss-activity action only appears when a real, still-listed batch filter is selected — never for All, and never for a filter that's already been removed from the list", () => {
    expect(source).toContain('{selectedFilter !== "all" && filters.some(f => f.batchId === selectedFilter) && <button type="button" className="lr-activity-dismiss-batch" onClick={() => onDismissActivity(selectedFilter)}>');
  });

  it("every event row is attributed with its own batch label (and browser label when known) — never presented as anonymous/unattributed activity", () => {
    expect(source).toContain('<span className="lr-activity-batch-tag">{event.batchLabel}{event.browserLabel ? ` · ${event.browserLabel}` : ""}</span>');
  });

  it("filter buttons use role=tab/aria-selected — a real, accessible tab-like control, not an unlabelled clickable div", () => {
    expect(source).toContain('role="tablist" aria-label="Filter activity by batch"');
    expect(source).toContain('role="tab" aria-selected={selectedFilter === "all"}');
  });
});

describe("Multi-batch support, follow-up correction — box dismissal now ALSO dismisses that same batch's activity (one-directional coupling, prevents duplicate Live Activity labels); activity-alone dismissal remains fully independent of the box", () => {
  const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");

  it("handleDismissBatchBox touches box-grid state (visibleBatchIds/batchStatusById/pairingCodeById) AND activity state (activityDismissedBatchIds/activityFilter) — a terminal box's × now dismisses its own activity too, so its display number can never be reallocated while its old activity is still visible under the same label", () => {
    const start = workspaceSource.indexOf("const handleDismissBatchBox = useCallback");
    const fn = workspaceSource.slice(start, workspaceSource.indexOf("}, []);", start) + 8);
    expect(fn).toContain('action: "dismiss_box"');
    expect(fn).toContain("setActivityDismissedBatchIds(current => new Set(current).add(batchId));");
    expect(fn).toContain('setActivityFilter(current => (current === batchId ? "all" : current));');
  });

  it("handleDismissBatchActivity only ever touches activity state (activityDismissedBatchIds/activityFilter) — it never touches visibleBatchIds/batchStatusById, so dismissing a batch's activity ALONE can never cancel or hide its box/processing", () => {
    const start = workspaceSource.indexOf("const handleDismissBatchActivity = useCallback");
    const fn = workspaceSource.slice(start, workspaceSource.indexOf("}, []);", start) + 8);
    expect(fn).toContain('action: "dismiss_activity"');
    expect(fn).not.toContain("setVisibleBatchIds");
    expect(fn).not.toContain("setBatchStatusById");
  });

  it("dismissing activity (via either path) resets the selected filter back to All only when the just-dismissed batch was the one selected — dismissing an unselected batch's activity never disturbs the current filter", () => {
    const matches = workspaceSource.match(/setActivityFilter\(current => \(current === batchId \? "all" : current\)\);/g) ?? [];
    // Present in BOTH handlers now — handleDismissBatchActivity (its own
    // original behaviour) and handleDismissBatchBox (the new coupling).
    expect(matches.length).toBe(2);
  });

  it("a reused display number can never mix a new batch's activity with an old, dismissed batch's — activityDismissedBatchIds and every activity event are keyed by the immutable batchId, never by displayNumber", () => {
    expect(workspaceSource).toContain("const [activityDismissedBatchIds, setActivityDismissedBatchIds] = useState<Set<string>>(new Set());");
    expect(workspaceSource).not.toMatch(/activityDismissedBatchIds.*displayNumber/);
  });

  it("REGRESSION: dismissing a batch's box never deletes its history — handleDismissBatchBox's server call is a PATCH (soft dismiss), never a DELETE", () => {
    const start = workspaceSource.indexOf("const handleDismissBatchBox = useCallback");
    const fn = workspaceSource.slice(start, workspaceSource.indexOf("}, []);", start) + 8);
    expect(fn).toContain('method: "PATCH"');
    expect(fn).not.toContain('method: "DELETE"');
  });
});

describe("Follow-up correction (orphaned extension batch recovery) — Hidden active batch section + Recover stuck batch dialog", () => {
  const workspaceSource = read("components/listings-review/ListingsReviewWorkspace.tsx");

  it("renders a Hidden active batch section whenever recoverableBatches is non-empty, offering a Recover stuck batch button per entry", () => {
    expect(workspaceSource).toContain('recoverableBatches.length > 0 && <section className="lr-hidden-batches-section"');
    expect(workspaceSource).toContain("recoverableBatches.map(batch =>");
    expect(workspaceSource).toContain('<button type="button" className="lr-hidden-batch-recover-button" onClick={() => openRecoverDialog(batch)}>Recover stuck batch</button>');
  });

  it("REQUIREMENT: the mount-resume fetch also captures the recoverable field into state, independent of whether any batch is visible", () => {
    const effectStart = workspaceSource.indexOf('const response = await fetch("/api/listing-studio/extension-batches");');
    const effectBody = workspaceSource.slice(effectStart, workspaceSource.indexOf("})();", effectStart));
    expect(effectBody).toContain("setRecoverableBatches(body.recoverable ?? []);");
    // Captured BEFORE the early-return for an empty batchIds list — a
    // resumed session with only hidden/stale batches (no ordinary visible
    // ones at all) must still see the Hidden active batch section.
    expect(effectBody.indexOf("setRecoverableBatches")).toBeLessThan(effectBody.indexOf("if (body.batchIds.length === 0) return;"));
  });

  it("openRecoverDialog fetches the batch's own current detail (never invents listing titles/counts) and computes completed/unfinished from real item statuses", () => {
    const start = workspaceSource.indexOf("const openRecoverDialog = useCallback");
    const fn = workspaceSource.slice(start, workspaceSource.indexOf("}, []);", start) + 8);
    expect(fn).toContain("fetch(`/api/listing-studio/extension-batches/${info.batchId}`)");
    expect(fn).toContain('item.status === "completed"');
    expect(fn).toContain('item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled"');
  });

  it("REQUIREMENT: handleRecoverBatch POSTs to the batch's own /recover endpoint with the exact force flag, never defaulting to a forced recovery", () => {
    const start = workspaceSource.indexOf("const handleRecoverBatch = useCallback");
    const fn = workspaceSource.slice(start, workspaceSource.indexOf("}, [recoverDialogBatch", start));
    expect(fn).toContain("fetch(`/api/listing-studio/extension-batches/${recoverDialogBatch.batchId}/recover`");
    expect(fn).toContain('method: "POST"');
    expect(fn).toContain("body: JSON.stringify({ force })");
  });

  it("REQUIREMENT: a 409 stillActive response re-arms the dialog for an explicit stronger confirmation — never silently retries or force-recovers on its own", () => {
    const start = workspaceSource.indexOf("const handleRecoverBatch = useCallback");
    const fn = workspaceSource.slice(start, workspaceSource.indexOf("}, [recoverDialogBatch", start));
    expect(fn).toContain("if (response.status === 409 && body.stillActive)");
    expect(fn).toContain("setRecoverStillActiveWarning(true)");
  });

  it("REQUIREMENT: after a successful recovery, releases the batch from live tracking, clears any now-stale selection of the released drafts, and refreshes listings — never resends anything automatically", () => {
    const start = workspaceSource.indexOf("const handleRecoverBatch = useCallback");
    const fn = workspaceSource.slice(start, workspaceSource.indexOf("}, [recoverDialogBatch", start));
    expect(fn).toContain("setVisibleBatchIds(current =>");
    expect(fn).toContain("setBatchStatusById(current =>");
    expect(fn).toContain("setBulkSelectedIds(current =>");
    expect(fn).toContain("await Promise.all([loadListings(), refreshRecoverableBatches()]);");
    expect(fn).not.toMatch(/handleSendToExtension\(/);
  });

  it("REQUIREMENT: the create-conflict error offers View active batch (visible+fresh) or Recover stuck batch (hidden/stale) inline, scoped to the real blockingBatch the server named", () => {
    expect(workspaceSource).toContain("{blockingBatch && <span className=\"lr-blocking-batch-actions\">");
    expect(workspaceSource).toContain("!blockingBatch.isHidden && !blockingBatch.isStale");
    expect(workspaceSource).toContain("openRecoverDialog(blockingBatch)");
  });

  it("closeRecoverDialog never closes mid-request (a click-away or Keep waiting during an in-flight recovery is a no-op)", () => {
    const start = workspaceSource.indexOf("const closeRecoverDialog = useCallback");
    const fn = workspaceSource.slice(start, workspaceSource.indexOf("[recovering]);", start) + 14);
    expect(fn).toContain("if (recovering) return;");
  });
});
