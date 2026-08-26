import type { VaultKind } from "@/lib/vault-storage";
export function VaultIcon({ kind }: { kind: VaultKind | "all" }) {
  const paths = { all: <><path d="M3 7h6l2 2h10v11H3z"/><path d="M3 7V5h7l2 2h9v2"/></>, note: <><path d="M5 3h11l3 3v15H5z"/><path d="M15 3v4h4M8 12h8M8 16h6"/></>, link: <><path d="m10 13 4-4"/><path d="M8 16H6a4 4 0 0 1 0-8h4M16 8h2a4 4 0 0 1 0 8h-4"/></>, file: <><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h4M8 13h8M8 17h6"/></>, guide: <><path d="M3 5.5A4.5 4.5 0 0 1 7.5 4H11v16H7.5A4.5 4.5 0 0 0 3 21z"/><path d="M21 5.5A4.5 4.5 0 0 0 16.5 4H13v16h3.5A4.5 4.5 0 0 1 21 21z"/></>, release: <><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 9h16M8 13h3"/></>, private: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></> };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[kind]}</svg>;
}
