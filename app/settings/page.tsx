"use client";

import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);

  function chooseTheme(next: "light" | "dark") {
    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem("purchase-tracker-theme", next);
    window.dispatchEvent(new Event("purchase-theme-change"));
  }

  return <section className="page-shell page-narrow">
    <header className="page-header"><div className="title-row"><h1>Settings</h1></div></header>
    <div className="settings-panel">
      <div className="settings-section">
        <div className="settings-copy"><h2>Appearance</h2><p>Choose how Purchase Tracker looks on this device.</p></div>
        <div className="theme-options">
          <button type="button" className={theme === "light" ? "theme-option theme-option-active" : "theme-option"} onClick={() => chooseTheme("light")}><span className="theme-preview theme-preview-light"><i /><i /></span><strong>Light</strong></button>
          <button type="button" className={theme === "dark" ? "theme-option theme-option-active" : "theme-option"} onClick={() => chooseTheme("dark")}><span className="theme-preview theme-preview-dark"><i /><i /></span><strong>Dark</strong></button>
        </div>
      </div>
      <div className="settings-row"><div><h2>Workspace</h2><p>Personal workspace · Supabase database</p></div><span className="status-badge"><i />Connected</span></div>
    </div>
  </section>;
}
