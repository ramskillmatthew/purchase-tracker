"use client";

import { createBrowserClient } from "@supabase/ssr";

export function browserAuthClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase Auth is not configured.");
  return createBrowserClient(url, key);
}

