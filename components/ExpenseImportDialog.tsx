"use client";

import SpreadsheetImportDialog from "@/components/SpreadsheetImportDialog";

const previewColumns = [
  { key: "order_date", label: "Order Date" },
  { key: "purchased_from", label: "Purchased From" },
  { key: "arrived", label: "Arrived" },
  { key: "item_description", label: "Item Description" },
  { key: "cost", label: "Cost" },
];

export default function ExpenseImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SpreadsheetImportDialog
    title="Import spreadsheet"
    description="Upload a completed template or CSV to add expenses in bulk."
    templateHref="/api/expenses/import/template"
    previewUrl="/api/expenses/import/preview"
    commitUrl="/api/expenses/import/commit"
    columns={previewColumns}
    itemNoun={{ singular: "expense", plural: "expenses" }}
    successNote="They now appear in your Expenses list."
    onClose={onClose}
    onImported={onImported}
  />;
}
