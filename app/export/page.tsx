"use client";
import { FormEvent, useState } from "react";

export default function ExportPage() {
  const [error, setError] = useState("");
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const data = new FormData(e.currentTarget);
    const start = data.get("start");
    const end = data.get("end");
    if (!start || !end) return setError("Choose both dates.");
    const type = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") || "purchases";
    window.location.href = `/api/export/${type}?start=${start}&end=${end}`;
  }

  return <section className="page-shell page-narrow">
    <header className="page-header"><div className="title-row"><h1>Export</h1></div></header>
    <form onSubmit={submit} className="card export-card grid gap-5 sm:grid-cols-2">
      <div className="export-intro sm:col-span-2"><span className="export-icon">↓</span><div><h2>Export date range</h2><p>Select the records to include.</p></div></div>
      <label className="field"><span className="label">Start Date</span><input className="input" name="start" type="date" required /></label>
      <label className="field"><span className="label">End Date</span><input className="input" name="end" type="date" required /></label>
      <button className="button export-button" type="submit" value="purchases"><span>↓</span>Export Purchases CSV</button>
      <button className="button-secondary export-button" type="submit" value="expenses"><span>↓</span>Export Expenses CSV</button>
      {error && <p className="text-sm text-red-600 sm:col-span-2">{error}</p>}
    </form>
  </section>;
}
