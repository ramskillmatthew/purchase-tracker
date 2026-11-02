"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { Task } from "@/lib/types";
import { isTaskActionableToday, TASKS_CHANGED_EVENT } from "@/lib/tasks";

type Theme = "space" | "dark" | "light";
type NavLink = { label: string; href: string; icon: string };
type NavGroup = { label?: string; links: NavLink[] };

const groups: NavGroup[] = [
  { links: [{ label: "Overview", href: "/", icon: "overview" }, { label: "Tasks", href: "/tasks", icon: "tasks" }] },
  { label: "Buying", links: [{ label: "Purchases", href: "/purchases", icon: "bag" }, { label: "Preorders", href: "/preorders", icon: "calendar" }] },
  { label: "Listing", links: [{ label: "Listing Studio", href: "/listing-studio", icon: "camera" }, { label: "Listings Review", href: "/listings-review", icon: "review" }, { label: "Listing Dashboard", href: "/listing-dashboard", icon: "inventory" }, { label: "Bulk Input", href: "/bulk-input", icon: "rows" }] },
  { label: "Selling", links: [{ label: "Sales", href: "/sales", icon: "tag" }, { label: "Returns, Losses & Write-offs", href: "/returns-losses", icon: "returns" }] },
  { label: "Money", links: [{ label: "Expenses", href: "/expenses", icon: "receipt" }, { label: "Investments", href: "/investments", icon: "chart" }] },
  { label: "Tools", links: [{ label: "Email Assistant", href: "/email-assistant", icon: "mail" }, { label: "Purchase Import", href: "/vinted-import", icon: "import" }, { label: "Export", href: "/export", icon: "download" }, { label: "Vault", href: "/vault", icon: "vault" }] },
];

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    overview: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
    tasks: <><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M8 3.5v3M16 3.5v3"/><path d="m8 12.5 2.3 2.3L16 9.5"/></>,
    bag: <><path d="M6.5 8.5h11l1 11h-13l1-11Z"/><path d="M9 9V6.5a3 3 0 0 1 6 0V9"/></>,
    calendar: <><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M8 3v4M16 3v4M4 9h16"/><path d="m9 14 2 2 4-4"/></>,
    tag: <><path d="M12.5 3.5h5A2 2 0 0 1 19.5 5.5v5a2 2 0 0 1-.6 1.4l-8 8a2 2 0 0 1-2.8 0l-4-4a2 2 0 0 1 0-2.8l8-8a2 2 0 0 1 1.4-.6Z"/><circle cx="16" cy="8" r="1"/></>,
    returns: <><path d="M4 8.5A7.5 7.5 0 1 1 5.5 15"/><path d="M4 4.5V9h4.5"/></>,
    camera: <><path d="M4 8.5a2 2 0 0 1 2-2h1.2l.9-1.5h7.8l.9 1.5H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z"/><circle cx="12" cy="13" r="3.3"/></>,
    review: <><rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/></>,
    inventory: <><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17M8 4v5M16 4v5"/><path d="M8 13h3M8 16h6"/></>,
    rows: <><path d="M5 6h14M5 12h14M5 18h14"/><path d="M8 4v4M13 10v4M17 16v4"/></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
    import: <><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M5 19h14"/></>,
    receipt: <><path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17Z"/><path d="M9 8h6M9 12h6"/></>,
    download: <><path d="M12 3.5v11M8 11l4 4 4-4"/><path d="M5 19.5h14"/></>,
    chart: <><path d="M4 20V4M4 20h16"/><path d="m7.5 15.5 3-4 3 2.5 4.5-6"/></>,
    vault: <><path d="M4 7.5h6l2 2h8v10H4z"/><path d="M4 7.5v-2h6l2 2h8v2"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    moon: <path d="M20 15.1A8.5 8.5 0 0 1 8.9 4 8.5 8.5 0 1 0 20 15.1Z"/>,
    sun: <><circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v2m0 15v2M2.5 12h2m15 0h2M5.3 5.3l1.4 1.4m10.6 10.6 1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></>,
    space: <><path d="M7 16c1.5-5 6-7.5 11-8-1 5-3.7 9.2-8.5 10.6"/><path d="M6 18c-1.5-3.5-.8-6.7 2.1-9.5 2.7.8 4.8 2.8 5.8 5.6"/><path d="M10 14c-2.8 1.8-4.8 4-6 6"/></>,
    pin: <><path d="M9 4h6l-.8 5 3.3 3.2v1.3h-11v-1.3L9.8 9 9 4Z"/><path d="M12 13.5V21"/></>,
  };
  return <svg className="app-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function BrandWordmark() {
  return <Link href="/" className="brand-link" aria-label="Trotter's Attire Trading HQ — Overview"><span className="brand-wordmark"><span className="brand-title">{"TROTTER'S ATTIR"}<span className="brand-e-wrap">E<Image src="/branding/trotters-checked-cap.png" alt="" width={90} height={72} className="brand-cap"/></span></span><span className="brand-subtitle"><span className="brand-subtitle-line"/><span className="brand-subtitle-text">TRADING HQ</span><span className="brand-subtitle-line"/></span></span></Link>;
}

function NavGroups({ taskBadgeCount, mobile = false }: { taskBadgeCount: number; mobile?: boolean }) {
  const pathname = usePathname();
  const active = (href: string) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
  const badge = taskBadgeCount > 99 ? "99+" : String(taskBadgeCount);
  return <>{groups.map(group => <div className={mobile ? "mobile-nav-group" : "sidebar-nav-group"} key={group.label ?? "primary"}>{group.label && <div className="sidebar-group-label">{group.label}</div>}{group.links.map(link => <Link key={link.href} href={link.href} className={`${mobile ? "mobile-nav-link" : "sidebar-link"} ${active(link.href) ? mobile ? "mobile-nav-active" : "sidebar-link-active" : ""}`}><Icon name={link.icon}/><span>{link.label}</span>{link.href === "/tasks" && taskBadgeCount > 0 && <span className="record-count sidebar-badge">{badge}</span>}</Link>)}</div>)}</>;
}

export default function AppHeader() {
  const pathname = usePathname();
  const [theme, setTheme] = useState<Theme>("dark");
  const [sidebarPinned, setSidebarPinned] = useState(true);
  const [sidebarHovered, setSidebarHovered] = useState(false);
  const [taskBadgeCount, setTaskBadgeCount] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setMobileOpen(false); }, [pathname]);
  useEffect(() => { const sync = () => { const saved = localStorage.getItem("purchase-tracker-theme"); setTheme(saved === "light" || saved === "dark" || saved === "space" ? saved : pathname === "/" ? "space" : "dark"); }; sync(); window.addEventListener("purchase-theme-change", sync); return () => window.removeEventListener("purchase-theme-change", sync); }, [pathname]);
  useEffect(() => { const saved = localStorage.getItem("purchase-tracker-sidebar-pinned"); setSidebarPinned(saved !== "false"); }, []);
  useEffect(() => { document.documentElement.dataset.sidebarState = sidebarPinned ? "pinned" : sidebarHovered ? "peek" : "collapsed"; return () => { delete document.documentElement.dataset.sidebarState; }; }, [sidebarPinned, sidebarHovered]);
  useEffect(() => { if (!mobileOpen) return; const previous = document.body.style.overflow; document.body.style.overflow = "hidden"; const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileOpen(false); }; window.addEventListener("keydown", close); return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", close); }; }, [mobileOpen]);
  useEffect(() => { if (pathname === "/login") return; let cancelled = false; async function loadBadge() { try { const response = await fetch("/api/tasks"); if (!response.ok || cancelled) return; const rows = await response.json() as Task[]; if (!cancelled) setTaskBadgeCount(rows.filter(task => isTaskActionableToday(task)).length); } catch {} } void loadBadge(); window.addEventListener(TASKS_CHANGED_EVENT, loadBadge); return () => { cancelled = true; window.removeEventListener(TASKS_CHANGED_EVENT, loadBadge); }; }, [pathname]);

  function chooseTheme(next: Theme) { setTheme(next); document.documentElement.classList.toggle("dark", next !== "light"); document.documentElement.classList.toggle("space", next === "space"); localStorage.setItem("purchase-tracker-theme", next); window.dispatchEvent(new Event("purchase-theme-change")); }
  function toggleSidebarPin() { const next = !sidebarPinned; setSidebarPinned(next); setSidebarHovered(false); localStorage.setItem("purchase-tracker-sidebar-pinned", String(next)); }
  if (pathname === "/login") return null;
  return <>
    <aside className="sidebar" onMouseEnter={() => { if (!sidebarPinned) setSidebarHovered(true); }} onMouseLeave={() => setSidebarHovered(false)}><BrandWordmark/><button type="button" className={`sidebar-pin ${sidebarPinned ? "active" : ""}`} onClick={toggleSidebarPin} aria-label={sidebarPinned ? "Unpin navigation" : "Pin navigation"} aria-pressed={sidebarPinned}><Icon name="pin"/></button><nav className="sidebar-nav"><NavGroups taskBadgeCount={taskBadgeCount}/></nav><div className="sidebar-settings"><Link href="/settings" className={pathname.startsWith("/settings") ? "sidebar-link sidebar-link-active" : "sidebar-link"}><Icon name="settings"/><span>Settings</span></Link></div>{pathname !== "/" && <><div className="theme-label">⌄ Theme ⌄</div><div className="theme-picker" aria-label="Theme"><button className={theme === "space" ? "active" : ""} onClick={() => chooseTheme("space")} type="button"><Icon name="space"/>Space</button><button className={theme === "dark" ? "active" : ""} onClick={() => chooseTheme("dark")} type="button"><Icon name="moon"/>Dark</button><button className={theme === "light" ? "active" : ""} onClick={() => chooseTheme("light")} type="button"><Icon name="sun"/>Light</button></div></>}</aside>
    <header className="mobile-topbar"><button type="button" className="mobile-menu-toggle" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><span/><span/><span/></button><BrandWordmark/><button type="button" className="mobile-theme" onClick={() => chooseTheme(theme === "light" ? "space" : "light")} aria-label="Change theme"><Icon name={theme === "light" ? "space" : "sun"}/></button></header>
    <div className={`mobile-nav-shell ${mobileOpen ? "mobile-nav-shell-open" : ""}`} aria-hidden={!mobileOpen}><button type="button" className="mobile-nav-backdrop" onClick={() => setMobileOpen(false)} aria-label="Close navigation"/><aside id="mobile-navigation" className="mobile-nav-drawer"><div className="mobile-nav-heading"><BrandWordmark/><button type="button" className="mobile-nav-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation">×</button></div><nav className="mobile-nav"><NavGroups taskBadgeCount={taskBadgeCount} mobile/><Link href="/settings" className="mobile-nav-link"><Icon name="settings"/><span>Settings</span></Link></nav></aside></div>
  </>;
}
