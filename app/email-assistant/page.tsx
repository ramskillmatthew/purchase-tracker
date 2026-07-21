"use client";
import { FormEvent, useState } from "react";

type Result = { id: string; sender: string; subject: string; date: string | null; folder: string; excerpt: string; whyMatched: string; hasAttachments: boolean; unread: boolean };
type Email = Result & { html: string; recipient: string; attachments: { filename: string; contentType: string; size: number }[] };

export default function EmailAssistantPage() {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [selected, setSelected] = useState<Email | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [suggestion, setSuggestion] = useState<{ original: string; corrected: string } | null>(null);

  async function search(message: string) {
    setSuggestion(null); setBusy(true); setError(""); setAnswer(""); setResults([]); setSelected(null);
    const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), 40_000);
    try {
      const response = await fetch("/api/assistant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }), signal: controller.signal });
      const body = await response.json();
      if (response.ok) { setAnswer(body.answer); setResults(body.results || []); } else setError(body.error || "Search failed.");
    } catch { setError("The email search took too long or the connection was interrupted. Please try again."); }
    finally { window.clearTimeout(timeout); setBusy(false); }
  }

  async function ask(event: FormEvent) {
    event.preventDefault(); setChecking(true); setError(""); setSuggestion(null);
    try {
      const response = await fetch("/api/assistant/suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: query }) });
      const body = await response.json();
      if (!response.ok) { setError(body.error || "The spelling check failed."); return; }
      if (body.changed) setSuggestion({ original: query, corrected: body.suggested }); else await search(query);
    } catch { setError("The spelling check was interrupted. Please try again."); }
    finally { setChecking(false); }
  }

  async function read(id: string) {
    setBusy(true); setError("");
    try { const response = await fetch("/api/yahoo/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }); const body = await response.json(); if (response.ok) setSelected(body); else setError(body.error || "Email could not be opened."); }
    catch { setError("The email could not be loaded because the connection was interrupted."); }
    finally { setBusy(false); }
  }

  return <section className="page-shell email-page"><header className="page-header"><div><span className="purchase-form-kicker">Read-only Yahoo Mail</span><h1>Email Assistant</h1><p>Search and summarise your mailbox with controlled Anthropic tools.</p></div></header>
    <form className="card assistant-search" onSubmit={ask}><label className="field"><span className="label">What would you like to find?</span><textarea className="input" value={query} onChange={event => { setQuery(event.target.value); setSuggestion(null); }} placeholder="Find receipts over £100 from last month." required maxLength={2000} /></label><div><span>Mailbox content is treated as untrusted data.</span><button className="button" disabled={busy || checking}>{checking ? "Checking spelling…" : busy ? "Searching…" : "Search emails"}</button></div></form>
    {suggestion && <div className="card search-suggestion" role="status"><div><strong>Did you mean:</strong><p>{suggestion.corrected}</p></div><div><button className="button" onClick={() => { setQuery(suggestion.corrected); void search(suggestion.corrected); }}>Search corrected</button><button className="button secondary" onClick={() => void search(suggestion.original)}>Keep original</button></div></div>}
    {error && <p className="bulk-save-error" role="alert">{error}</p>}{answer && <div className="card assistant-answer"><strong>Assistant</strong><p>{answer}</p></div>}
    <div className="email-layout"><div className="data-panel email-results"><div className="grid-toolbar"><strong>{results.length} results</strong><span>{busy ? "Working…" : "Newest relevant matches"}</span></div>{results.length ? results.map(row => <button className="email-result" key={row.id} onClick={() => read(row.id)}><span><strong>{row.sender}</strong><time>{row.date ? new Date(row.date).toLocaleString() : "Unknown date"}</time></span><b>{row.unread && <i>Unread</i>}{row.subject}</b><p>{row.excerpt || "No text preview available."}</p><small>{row.folder} · {row.whyMatched}{row.hasAttachments ? " · Attachment" : ""}</small></button>) : <div className="email-empty">Ask a question to search your Yahoo mailbox.</div>}</div>
      <div className="card email-reader">{selected ? <><header><button onClick={() => setSelected(null)}>Close</button><span>{selected.folder}</span><h2>{selected.subject}</h2><p>From {selected.sender}<br/>To {selected.recipient}</p></header><article dangerouslySetInnerHTML={{ __html: selected.html }} />{selected.attachments.length > 0 && <footer><strong>Attachments (not downloaded)</strong>{selected.attachments.map(item => <span key={item.filename}>{item.filename} · {item.contentType}</span>)}</footer>}</> : <div className="email-empty">Select a result to read its sanitized content.</div>}</div></div>
  </section>;
}
