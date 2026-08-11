"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type OverflowMenuItem = { label: string; onClick: () => void; disabled?: boolean; tone?: "default" | "danger"; title?: string };

const MENU_WIDTH = 180;
const VIEWPORT_MARGIN = 8;

/**
 * A small "⋯" trigger + dropdown for less-common actions. The dropdown is
 * rendered in a portal attached to document.body — never inside whatever
 * scrollable container the trigger happens to live in — because any
 * ancestor with `overflow-x: auto` (e.g. the Listings Review table's own
 * horizontal scroll wrapper) forces `overflow-y` to also compute as
 * clipping per the CSS Overflow spec (setting one axis to non-visible
 * implicitly changes a "visible" other axis to "auto"), which silently
 * clipped this menu whenever it would have extended past the row's own
 * vertical bounds — the exact "invisible/clipped menu" defect this
 * component previously had. Positioned via the trigger's own
 * getBoundingClientRect() on open, flips above the trigger when there's
 * insufficient room below, and is clamped so it can never extend past the
 * viewport edge. Closes on Escape or an outside click (checked against
 * both the trigger and the portaled menu, since a portal is a different
 * DOM subtree); every item is a real, keyboard-reachable
 * <button role="menuitem">; arrow keys move focus between items; closing
 * via Escape or an item selection returns focus to the trigger.
 */
export default function OverflowMenu({ label, items }: { label: string; items: OverflowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; openUpward: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const computePosition = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const estimatedHeight = menuRef.current?.offsetHeight ?? items.length * 32 + 10;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUpward = spaceBelow < estimatedHeight + VIEWPORT_MARGIN && rect.top > estimatedHeight + VIEWPORT_MARGIN;
    const left = Math.min(Math.max(rect.right - MENU_WIDTH, VIEWPORT_MARGIN), window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN);
    const top = openUpward ? Math.max(VIEWPORT_MARGIN, rect.top - estimatedHeight - 4) : rect.bottom + 4;
    setPosition({ top, left, openUpward });
  };

  // Position (and reposition) whenever the menu is open — computed twice on
  // open (once with an estimated height, once with the portal's real
  // rendered height) so the very first paint is already correctly flipped
  // when there's genuinely no room below.
  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-measures using the now-rendered menuRef height; deliberately re-runs once more after mount
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    computePosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one extra measurement pass now that menuRef has real content
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    // Focus the first enabled item once the menu is actually on screen.
    const firstEnabled = itemRefs.current.find(el => el && !el.disabled);
    firstEnabled?.focus();

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (containerRef.current?.contains(event.target as Node)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); return; }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const enabled = itemRefs.current.map((el, i) => (el && !el.disabled ? i : -1)).filter(i => i >= 0);
      if (!enabled.length) return;
      const current = itemRefs.current.findIndex(el => el === document.activeElement);
      const currentPos = enabled.indexOf(current);
      const nextPos = event.key === "ArrowDown"
        ? (currentPos + 1) % enabled.length
        : (currentPos - 1 + enabled.length) % enabled.length;
      itemRefs.current[enabled[nextPos]]?.focus();
    }
    // Reposition on scroll/resize so the menu never visually detaches from
    // its trigger while the page moves underneath it.
    function handleReflow() { computePosition(); }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleReflow, true);
    window.addEventListener("resize", handleReflow);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleReflow, true);
      window.removeEventListener("resize", handleReflow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- computePosition closes over refs/items, not state; re-subscribing only on open/close is correct
  }, [open]);

  return <div className="overflow-menu" ref={containerRef}>
    <button ref={triggerRef} type="button" className="overflow-menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(current => !current)}>⋯</button>
    {open && position && typeof document !== "undefined" && createPortal(
      <div
        ref={menuRef}
        className="overflow-menu-list overflow-menu-list-portal"
        role="menu"
        style={{ position: "fixed", top: position.top, left: position.left, width: MENU_WIDTH }}
      >
        {items.map((item, index) => <button
          key={item.label}
          ref={el => { itemRefs.current[index] = el; }}
          type="button"
          role="menuitem"
          className={`overflow-menu-item${item.tone === "danger" ? " overflow-menu-item-danger" : ""}`}
          disabled={item.disabled}
          title={item.title}
          onClick={() => { setOpen(false); triggerRef.current?.focus(); item.onClick(); }}
        >{item.label}</button>)}
      </div>,
      document.body,
    )}
  </div>;
}
