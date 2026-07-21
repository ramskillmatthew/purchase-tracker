import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export class AuthError extends Error {
  name = "AuthError";
  status = 401;
}

function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Public Supabase Auth configuration is missing.");
  return { url, key };
}

export async function serverAuthClient() {
  const { url, key } = publicConfig();
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (values) => {
        try { values.forEach(({ name, value, options }) => store.set(name, value, options)); }
        catch { /* Server Components cannot write refreshed cookies. Middleware handles it. */ }
      },
    },
  });
}

export async function requireOwner() {
  const client = await serverAuthClient();
  const { data: { user }, error } = await client.auth.getUser();
  const owner = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (error || !user?.email || !owner || user.email.toLowerCase() !== owner) {
    throw new AuthError("Authentication required.");
  }
  return user;
}
