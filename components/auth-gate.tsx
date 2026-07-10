"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { authRequired } from "@/lib/auth-mode";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { ready, profile, signOut } = useAuth();

  useEffect(() => {
    if (!authRequired || !ready || pathname === "/login") return;
    if (!profile) router.replace("/login");
  }, [pathname, profile, ready, router]);

  if (!authRequired || pathname === "/login") return <>{children}</>;
  if (!ready) return <main className="auth-loading">Checking access…</main>;
  if (!profile) return null;
  if (!profile.access) {
    return (
      <main className="auth-frame">
        <section className="auth-card" role="alert">
          <p className="auth-eyebrow">Lease Ledger</p>
          <h1>Superadmin access required.</h1>
          <p>Your account is authenticated, but it does not have superadmin access.</p>
          <button className="auth-button" type="button" onClick={() => void signOut()}>Sign out</button>
        </section>
      </main>
    );
  }
  return <>{children}</>;
}
