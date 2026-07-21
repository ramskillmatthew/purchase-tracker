"use client";

import { FormEvent, useState } from "react";
import { browserAuthClient } from "@/lib/auth/browser";

export default function LoginPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const values = new FormData(event.currentTarget);
    const { error: authError } = await browserAuthClient().auth.signInWithPassword({ email: String(values.get("email")), password: String(values.get("password")) });
    if (authError) { setError("Sign-in failed."); setBusy(false); return; }
    const requested = new URLSearchParams(window.location.search).get("next");
    window.location.assign(requested?.startsWith("/") && !requested.startsWith("//") ? requested : "/");
  }
  return <main className="login-shell"><form className="card login-card" onSubmit={submit}>
    <span className="purchase-form-kicker">Private workspace</span><h1>Sign in</h1><p>Use the allowlisted Supabase owner account.</p>
    <label className="field"><span className="label">Email</span><input className="input" name="email" type="email" autoComplete="email" required /></label>
    <label className="field"><span className="label">Password</span><input className="input" name="password" type="password" autoComplete="current-password" required /></label>
    {error && <p className="purchase-form-error" role="alert">{error}</p>}
    <button className="button" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
  </form></main>;
}
