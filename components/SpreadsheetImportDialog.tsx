"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SpreadsheetImportFailure } from "@/lib/spreadsheet-import/types";

type RowError = { field: string; reason: string };
type PreviewRow = { row: number; values: Record<string, string>; errors: RowError[] };
type PreviewResponse = {
  fileName: string; totalDataRows: number; validCount: number; invalidCount: number;
  ignoredColumns: string[]; rows: PreviewRow[]; invalidRows: PreviewRow[]; failures: SpreadsheetImportFailure[];
  truncated: boolean; previewRowLimit: number; maxImportRows: number;
};

const ACCEPTED_EXTENSIONS = [".xlsx", ".csv"];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DISPLAYED_VALUE_LENGTH = 60;

function hasAcceptedExtension(name: string) {
  const lower = name.trim().toLowerCase();
  return ACCEPTED_EXTENSIONS.some(extension => lower.endsWith(extension));
}

function truncateValue(value: string): string {
  return value.length > MAX_DISPLAYED_VALUE_LENGTH ? `${value.slice(0, MAX_DISPLAYED_VALUE_LENGTH)}…` : value;
}

/**
 * Our own reason strings already name the field they're about (e.g.
 * "Order Date is not a real date.") — shown next to a bolded field label,
 * that would read as "Order Date — Order Date is not a real date.". This
 * only trims an exact leading repeat for display; the underlying `reason`
 * text itself (and every validation message) is untouched.
 */
function displayReason(label: string, reason: string): string {
  return reason.startsWith(label) ? reason.slice(label.length).replace(/^\s+/, "") : reason;
}

/**
 * Domain-agnostic import dialog shell: modal, upload/drop zone, preview
 * table, row-level errors, confirm/cancel actions, success state. Every
 * import feature (purchases, expenses, ...) renders this with its own
 * columns, endpoints, and wording — see components/PurchaseImportDialog.tsx
 * and components/ExpenseImportDialog.tsx for the thin per-domain wrappers.
 * Behaviour here must stay identical across domains; anything
 * domain-specific belongs in the wrapper, not in this file.
 */
export default function SpreadsheetImportDialog({
  title, description, templateHref, previewUrl, commitUrl, columns, itemNoun, successNote, onClose, onImported,
}: {
  title: string;
  description: string;
  templateHref: string;
  previewUrl: string;
  commitUrl: string;
  columns: { key: string; label: string }[];
  itemNoun: { singular: string; plural: string };
  successNote: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [selectError, setSelectError] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [viewTab, setViewTab] = useState<"all" | "needs-attention">("all");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState("");
  const [result, setResult] = useState<{ created: number } | null>(null);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  // A contract mismatch (invalid rows reported but no failure details
  // received) must never be silently swallowed — surfaced as a safe,
  // non-sensitive console error a developer can find, never a raw
  // stack trace or file content.
  useEffect(() => {
    if (preview && preview.invalidCount > 0 && preview.failures.length === 0) {
      console.error(`Spreadsheet import preview reported ${preview.invalidCount} invalid row(s) but included no failure details. This indicates an API/UI contract mismatch, not a user error.`);
    }
  }, [preview]);

  const columnLabel = useMemo(() => {
    const map = new Map(columns.map(column => [column.key, column.label]));
    return (key: string) => map.get(key) ?? key;
  }, [columns]);

  const failuresByRow = useMemo(() => {
    if (!preview) return [];
    const map = new Map<number, SpreadsheetImportFailure[]>();
    for (const failure of preview.failures) map.set(failure.row, [...(map.get(failure.row) ?? []), failure]);
    return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([row, failures]) => ({ row, failures }));
  }, [preview]);

  async function handleFile(selected: File) {
    setSelectError("");
    setPreview(null);
    setCommitError("");
    setResult(null);
    if (!hasAcceptedExtension(selected.name)) { setSelectError(`Unsupported file type. Please choose a ${ACCEPTED_EXTENSIONS.join(" or ")} file.`); setFile(null); return; }
    if (selected.size > MAX_FILE_BYTES) { setSelectError("This file is too large. Maximum size is 5MB."); setFile(null); return; }
    setFile(selected);
    setLoadingPreview(true);
    try {
      const formData = new FormData();
      formData.append("file", selected);
      const response = await fetch(previewUrl, { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) { setSelectError(body.error || "Could not read this file."); setFile(null); return; }
      setPreview(body);
      // Surface the rows that need fixing first — that's the actionable view for a file with errors.
      setViewTab(body.invalidCount > 0 ? "needs-attention" : "all");
    } catch { setSelectError("Could not read this file. Please try again."); setFile(null); }
    finally { setLoadingPreview(false); }
  }

  function chooseAnother() {
    setFile(null); setPreview(null); setSelectError(""); setCommitError(""); setResult(null); setViewTab("all");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function confirmImport() {
    if (submitting.current || !file || !preview) return;
    submitting.current = true;
    setCommitting(true);
    setCommitError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(commitUrl, { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) { setCommitError(body.error || `Could not import ${itemNoun.plural}.`); return; }
      setResult({ created: body.created });
      onImported();
    } catch { setCommitError(`Could not import ${itemNoun.plural}. Please try again.`); }
    finally { setCommitting(false); submitting.current = false; }
  }

  const canImport = Boolean(preview) && preview!.invalidCount === 0 && preview!.validCount > 0 && preview!.validCount <= preview!.maxImportRows;
  const reviewing = Boolean(file) || Boolean(selectError);
  const displayedRows = preview ? (viewTab === "needs-attention" ? preview.invalidRows : preview.rows) : [];

  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !reviewing) onClose(); }}>
    <div className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
      <div className="import-dialog-heading">
        <div><h2 id="import-dialog-title">{title}</h2><p>{description}</p></div>
        <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      {result ? (
        <div className="import-success">
          <span aria-hidden="true">✓</span>
          <h3>{result.created} {result.created === 1 ? itemNoun.singular : itemNoun.plural} imported.</h3>
          <p>{successNote}</p>
          <div className="import-dialog-actions"><button type="button" className="button" onClick={onClose}>Done</button></div>
        </div>
      ) : (
        <>
          <a className="button-secondary import-template-link" href={templateHref}>Download Excel template</a>

          {!file && (
            <label className={`import-dropzone${dragOver ? " import-dropzone-active" : ""}`}
              onDragOver={event => { event.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={event => { event.preventDefault(); setDragOver(false); const dropped = event.dataTransfer.files?.[0]; if (dropped) handleFile(dropped); }}>
              <input ref={inputRef} type="file" accept=".xlsx,.csv" aria-label="Choose a spreadsheet file to import"
                onChange={event => { const chosen = event.target.files?.[0]; if (chosen) handleFile(chosen); }} />
              <span className="import-dropzone-title">Click to choose a file, or drag one here</span>
              <span className="import-dropzone-hint">.xlsx or .csv, up to 5MB</span>
            </label>
          )}

          {selectError && <p className="import-select-error" role="alert">{selectError}</p>}
          {loadingPreview && <p className="import-loading">Reading file…</p>}

          {preview && (
            <>
              <div className="import-summary">
                <div><strong>{preview.fileName}</strong><span>{preview.totalDataRows} row{preview.totalDataRows === 1 ? "" : "s"} detected</span></div>
                <div className="import-counts">
                  <span className="import-count-valid">✓ {preview.validCount} valid</span>
                  <span className={preview.invalidCount ? "import-count-invalid" : ""}>{preview.invalidCount ? "⚠ " : ""}{preview.invalidCount} need attention</span>
                </div>
              </div>
              {preview.ignoredColumns.length > 0 && <p className="import-note">Not imported (unrecognised column{preview.ignoredColumns.length === 1 ? "" : "s"}): {preview.ignoredColumns.join(", ")}</p>}
              {preview.validCount > preview.maxImportRows && <p className="import-select-error" role="alert">This file has {preview.validCount} valid rows. You can import up to {preview.maxImportRows} per operation — split it into smaller files.</p>}

              {preview.invalidCount > 0 && (
                <div className="import-error-list">
                  <strong>{preview.invalidCount} row{preview.invalidCount === 1 ? "" : "s"} need attention</strong>
                  <p className="import-error-hint">Correct these rows in the spreadsheet, then upload the file again.</p>
                  {failuresByRow.length > 0 ? (
                    <ul className="import-error-rows" aria-label="Rows that need attention">
                      {failuresByRow.map(({ row, failures }) => (
                        <li key={row} className="import-error-row">
                          <span className="import-error-row-number">Row {row}</span>
                          <ul>
                            {failures.map((failure, index) => (
                              <li key={`${failure.field}-${index}`}>
                                <strong>{columnLabel(failure.field)}</strong> — {displayReason(columnLabel(failure.field), failure.reason)}
                                {failure.value && <span className="import-error-value"> (“{truncateValue(failure.value)}”)</span>}
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="import-error-fallback" role="alert">The file contains {preview.invalidCount} invalid row{preview.invalidCount === 1 ? "" : "s"}, but their details could not be displayed. Please try uploading it again.</p>
                  )}
                </div>
              )}

              <div className="import-view-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={viewTab === "all"} className={viewTab === "all" ? "import-view-tab import-view-tab-active" : "import-view-tab"} onClick={() => setViewTab("all")}>All rows</button>
                <button type="button" role="tab" aria-selected={viewTab === "needs-attention"} className={viewTab === "needs-attention" ? "import-view-tab import-view-tab-active" : "import-view-tab"} onClick={() => setViewTab("needs-attention")} disabled={preview.invalidCount === 0}>Needs attention <i>{preview.invalidCount}</i></button>
              </div>
              {viewTab === "all" && preview.truncated && <p className="import-note">Showing the first {preview.previewRowLimit} of {preview.totalDataRows} rows. All {preview.totalDataRows} rows were validated.</p>}

              <div className="table-scroll import-preview-scroll">
                <table className="import-preview-table">
                  <thead><tr><th>#</th>{columns.map(column => <th key={column.key}>{column.label}</th>)}</tr></thead>
                  <tbody>
                    {displayedRows.map(row => {
                      const errorFields = new Map(row.errors.map(error => [error.field, error.reason]));
                      return <tr key={row.row} className={row.errors.length ? "import-row-invalid" : ""}>
                        <td><span className={row.errors.length ? "import-row-status import-row-status-error" : "import-row-status import-row-status-ok"}>{row.errors.length ? "⚠" : "✓"} {row.row}</span></td>
                        {columns.map(column => {
                          const cellReason = errorFields.get(column.key);
                          return <td key={column.key} className={cellReason ? "import-cell-error" : ""}>
                            <div>{row.values[column.key] || "—"}</div>
                            {viewTab === "needs-attention" && cellReason && <div className="import-cell-error-note">{cellReason}</div>}
                          </td>;
                        })}
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>

              {commitError && <p className="import-select-error" role="alert">{commitError}</p>}
              {preview.invalidCount > 0 && <p className="import-disabled-reason">Resolve all {preview.invalidCount} invalid row{preview.invalidCount === 1 ? "" : "s"} before importing.</p>}

              <div className="import-dialog-actions">
                <button type="button" className="button-secondary" onClick={onClose}>Cancel</button>
                <button type="button" className="button-secondary" onClick={chooseAnother}>Choose another file</button>
                <button type="button" className="button" disabled={!canImport || committing} onClick={confirmImport}>{committing ? "Importing…" : `Import ${preview.validCount || ""} valid ${preview.validCount === 1 ? itemNoun.singular : itemNoun.plural}`}</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  </div>;
}
