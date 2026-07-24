"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { Task } from "@/lib/types";
import { isTaskActionableToday, TASKS_CHANGED_EVENT } from "@/lib/tasks";

const links = [
  { label: "Home", href: "/", icon: "home" },
  { label: "Tasks", href: "/tasks", icon: "tasks" },
  { label: "Purchases", href: "/purchases", icon: "bag" },
  { label: "Bulk Input", href: "/bulk-input", icon: "rows" },
  { label: "Email Assistant", href: "/email-assistant", icon: "mail" },
  { label: "Purchase Import", href: "/vinted-import", icon: "import" },
  { label: "Expenses", href: "/expenses", icon: "receipt" },
  { label: "Export", href: "/export", icon: "download" },
  { label: "Settings", href: "/settings", icon: "settings" },
];

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="m4 10 8-6 8 6" /><path d="M6.5 9v10.5h11V9M10 19v-6h4v6" /></>,
    tasks: <><rect x="4" y="5" width="16" height="15" rx="2.5" /><path d="M8 3.5v3M16 3.5v3" /><path d="m8 12.5 2.3 2.3L16 9.5" /></>,
    bag: <><path d="M6.5 8.5h11l1 11h-13l1-11Z" /><path d="M9 9V6.5a3 3 0 0 1 6 0V9" /></>,
    rows: <><path d="M5 6h14M5 12h14M5 18h14" /><path d="M8 4v4M13 10v4M17 16v4" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
    import: <><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M5 19h14"/></>,
    receipt: <><path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17Z" /><path d="M9 8h6M9 12h6" /></>,
    download: <><path d="M12 3.5v11M8 11l4 4 4-4" /><path d="M5 19.5h14" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
    sun: <><circle cx="12" cy="12" r="3.5" /><path d="M12 2.5v2m0 15v2M2.5 12h2m15 0h2M5.3 5.3l1.4 1.4m10.6 10.6 1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>,
    moon: <path d="M20 15.1A8.5 8.5 0 0 1 8.9 4 8.5 8.5 0 1 0 20 15.1Z" />,
  };
  return <svg className="app-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export default function AppHeader() {
  const pathname = usePathname();
  const [dark, setDark] = useState(false);
  const [taskBadgeCount, setTaskBadgeCount] = useState(0);

  useEffect(() => {
    const syncTheme = () => setDark(document.documentElement.classList.contains("dark"));
    syncTheme();
    window.addEventListener("purchase-theme-change", syncTheme);
    return () => window.removeEventListener("purchase-theme-change", syncTheme);
  }, []);

  useEffect(() => {
    if (pathname === "/login") return;
    let cancelled = false;
    async function loadBadge() {
      try {
        const r = await fetch("/api/tasks");
        if (!r.ok || cancelled) return;
        const rows = (await r.json()) as Task[];
        if (!cancelled) setTaskBadgeCount(rows.filter(task => isTaskActionableToday(task)).length);
      } catch { /* badge is a convenience — a failed refresh just leaves the previous count showing */ }
    }
    loadBadge();
    // Other pages/components dispatch this after any create/complete/
    // uncomplete/delete (see lib/tasks.ts's broadcastTasksChanged) so the
    // nav badge stays live without a shared store — mirrors the existing
    // "purchase-theme-change" pattern just above.
    window.addEventListener(TASKS_CHANGED_EVENT, loadBadge);
    return () => { cancelled = true; window.removeEventListener(TASKS_CHANGED_EVENT, loadBadge); };
  }, [pathname]);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("purchase-tracker-theme", next ? "dark" : "light");
    window.dispatchEvent(new Event("purchase-theme-change"));
  }

  const isActive = (href: string) => pathname === href || (href === "/purchases" && pathname.startsWith("/purchases/"));
  // Reuses the existing .record-count pill (already used identically on
  // the Tasks page header) rather than inventing a new badge style.
  const badgeLabel = taskBadgeCount > 99 ? "99+" : String(taskBadgeCount);

  if (pathname === "/login") return null;

  return <>
    <aside className="sidebar">
      <Link href="/" className="product-logo">
        <span className="product-logo-icon">P</span>
        <span><strong>Purchase</strong><small>Tracker</small></span>
      </Link>
      <div className="sidebar-label">Workspace</div>
      <nav className="sidebar-nav">
        {links.map((link) => <Link key={link.href} href={link.href} className={isActive(link.href) ? "sidebar-link sidebar-link-active" : "sidebar-link"}>
          <Icon name={link.icon} /><span>{link.label}</span>
          {link.href === "/tasks" && taskBadgeCount > 0 && <span className="record-count sidebar-badge">{badgeLabel}</span>}
        </Link>)}
      </nav>
      <div className="sidebar-spacer" />
      <div className="workspace-card"><span className="workspace-dot" /><div><strong>Personal workspace</strong><small>Private database</small></div></div>
      <button type="button" className="sidebar-theme" onClick={toggleTheme}><Icon name={dark ? "sun" : "moon"} /><span>{dark ? "Light mode" : "Dark mode"}</span><span className="theme-shortcut">{dark ? "Light" : "Dark"}</span></button>
    </aside>

    <header className="mobile-topbar">
      <Link href="/" className="product-logo"><span className="product-logo-icon">P</span><span><strong>Purchase</strong><small>Tracker</small></span></Link>
      <button type="button" className="mobile-theme" onClick={toggleTheme} aria-label={`Switch to ${dark ? "light" : "dark"} mode`}><Icon name={dark ? "sun" : "moon"} /></button>
    </header>

    <nav className="mobile-nav">
      {links.map((link) => <Link key={link.href} href={link.href} className={isActive(link.href) ? "mobile-nav-link mobile-nav-active" : "mobile-nav-link"}>
        <span className="mobile-nav-icon-wrap">
          <Icon name={link.icon} />
          {link.href === "/tasks" && taskBadgeCount > 0 && <span className="record-count mobile-nav-badge">{badgeLabel}</span>}
        </span>
        <span>{link.label}</span>
      </Link>)}
    </nav>
  </>;
}
