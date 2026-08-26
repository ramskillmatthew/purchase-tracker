"use client";

import SpreadsheetImportDialog from "@/components/SpreadsheetImportDialog";
import { purchasesImportedMessage } from "@/lib/success-messages";

const previewColumns = [
  { key: "order_date", label: "Order Date" },
  { key: "purchased_from", label: "Purchased From" },
  { key: "sku", label: "SKU" },
  { key: "arrived", label: "Arrived" },
  { key: "item_description", label: "Item Description" },
  { key: "item_size", label: "Size" },
  { key: "item_condition", label: "Item Condition" },
  { key: "category", label: "Category" },
  { key: "price_purchased", label: "Price Purchased" },
];

export default function PurchaseImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  return <SpreadsheetImportDialog
    title="Import spreadsheet"
    description="Upload a completed template or CSV to add purchases in bulk."
    templateHref="/api/purchases/import/template"
    previewUrl="/api/purchases/import/preview"
    commitUrl="/api/purchases/import/commit"
    columns={previewColumns}
    itemNoun={{ singular: "purchase", plural: "purchases" }}
    successNote="They now appear in your Purchases list."
    successHeading={purchasesImportedMessage}
    onClose={onClose}
    onImported={onImported}
  />;
}
