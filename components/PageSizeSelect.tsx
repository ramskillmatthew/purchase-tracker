"use client";

import { PAGE_SIZE_OPTIONS, type PageSize } from "@/lib/pagination";

// Label wraps the select so the accessible name is associated implicitly —
// the same convention already used by every other <select> in this app
// (see components/TaskFormModal.tsx) rather than introducing id/htmlFor.
export default function PageSizeSelect({ value, onChange }: { value: PageSize; onChange: (size: PageSize) => void }) {
  return (
    <label className="page-size-select">
      <span>Items per page</span>
      <select className="input" value={value} onChange={event => onChange(Number(event.target.value) as PageSize)}>
        {PAGE_SIZE_OPTIONS.map(size => <option key={size} value={size}>{size}</option>)}
      </select>
    </label>
  );
}
