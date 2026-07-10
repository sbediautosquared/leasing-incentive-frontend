"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { authRequired } from "@/lib/auth-mode";
import { fetchAccessLevel } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authRequired) return;
    void createClient().auth.getSession().then(({ data }) => {
      if (data.session) router.replace("/");
    });
  }, [router]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      if (!data.session || (await fetchAccessLevel(supabase)) !== "superadmin") {
        await supabase.auth.signOut();
        throw new Error("Your account does not have superadmin access.");
      }
      router.replace("/");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not sign in.");
      setBusy(false);
    }
  };

  if (!authRequired) {
    return <main className="auth-frame"><section className="auth-card"><p className="auth-eyebrow">Lease Ledger</p><h1>Authentication is disabled.</h1><p>This local environment is configured for open development access.</p></section></main>;
  }

  return (
    <main className="auth-frame">
      <form className="auth-card" onSubmit={submit}>
        <p className="auth-eyebrow">Lease Ledger</p>
        <h1>Sign in to the workspace.</h1>
        <p>Use your managed company account to review residual files.</p>
        <label><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="auth-button" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
