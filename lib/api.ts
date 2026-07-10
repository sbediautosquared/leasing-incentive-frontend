import { authRequired } from "@/lib/auth-mode";
import { createClient } from "@/lib/supabase/client";

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (authRequired) {
    const { data } = await createClient().auth.getSession();
    if (data.session) headers.set("Authorization", `Bearer ${data.session.access_token}`);
  }
  return fetch(input, { ...init, headers });
}

