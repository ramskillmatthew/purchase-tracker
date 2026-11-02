"use client";

export default function UnsavedChangesDialog({ saving, onSaveAndExit, onExitWithoutSaving, onContinueEditing }: {
  saving: boolean;
  onSaveAndExit: () => void;
  onExitWithoutSaving: () => void;
  onContinueEditing: () => void;
}) {
  return <div className="dialog-backdrop unsaved-changes-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !saving) onContinueEditing();
  }}>
    <div className="confirm-dialog unsaved-changes-dialog" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-changes-title" aria-describedby="unsaved-changes-copy">
      <div className="dialog-copy">
        <p className="dialog-eyebrow">Unsaved changes</p>
        <h2 id="unsaved-changes-title">Save before exiting?</h2>
        <p id="unsaved-changes-copy">You have changes that have not been saved yet.</p>
      </div>
      <div className="dialog-actions unsaved-changes-actions">
        <button type="button" className="button-secondary" onClick={onContinueEditing} disabled={saving}>Continue editing</button>
        <button type="button" className="button-secondary unsaved-changes-discard" onClick={onExitWithoutSaving} disabled={saving}>Exit without saving</button>
        <button type="button" className="button" onClick={onSaveAndExit} disabled={saving}>{saving ? "Saving…" : "Save changes and exit"}</button>
      </div>
    </div>
  </div>;
}
