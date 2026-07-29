"use client";

import { useEffect, useRef, useState } from "react";

export type OverflowMenuItem = { label: string; onClick: () => void; disabled?: boolean; tone?: "default" | "danger"; title?: string };

/**
 * A small "⋯" trigger + dropdown for less-common actions (UX refinement
 * spec §7: "Place less-common actions in a three-dot menu"). Closes on
 * Escape or an outside click; every item is a real, keyboard-reachable
 * <button role="menuitem">.
 */
export default function OverflowMenu({ label, items }: { label: string; items: OverflowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) { if (!containerRef.current?.contains(event.target as Node)) setOpen(false); }
    function handleKeyDown(event: KeyboardEvent) { if (event.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("mousedown", handlePointerDown); document.removeEventListener("keydown", handleKeyDown); };
  }, [open]);

  return <div className="overflow-menu" ref={containerRef}>
    <button type="button" className="overflow-menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(current => !current)}>⋯</button>
    {open && <div className="overflow-menu-list" role="menu">
      {items.map(item => <button
        key={item.label}
        type="button"
        role="menuitem"
        className={`overflow-menu-item${item.tone === "danger" ? " overflow-menu-item-danger" : ""}`}
        disabled={item.disabled}
        title={item.title}
        onClick={() => { setOpen(false); item.onClick(); }}
      >{item.label}</button>)}
    </div>}
  </div>;
}
