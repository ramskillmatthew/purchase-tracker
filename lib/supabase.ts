function config() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase environment variables are not configured.");
  return { url, key };
}

export async function supabaseRequest(path: string, init?: RequestInit) {
  const { url, key } = config();
  const headers = new Headers(init?.headers);
  headers.set("apikey", key);
  headers.set("Content-Type", "application/json");
  if (!key.startsWith("sb_secret_")) headers.set("Authorization", `Bearer ${key}`);
  const response = await fetch(`${url}/rest/v1/${path}`, { ...init, headers, cache: "no-store" });
  if (!response.ok) throw new Error((await response.text()) || "Database request failed.");
  return response;
}
