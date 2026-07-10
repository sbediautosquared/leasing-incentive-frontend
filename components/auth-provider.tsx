"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { authRequired } from "@/lib/auth-mode";
import { createClient } from "@/lib/supabase/client";
import { AuthProfile, toAuthProfile } from "@/lib/auth";

type AuthContextValue = {
  ready: boolean;
  session: Session | null;
  profile: AuthProfile | null;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  ready: !authRequired,
  session: null,
  profile: authRequired ? null : {
    id: "local-development",
    email: "",
    displayName: "Local development",
    access: "superadmin",
  },
  signOut: async () => undefined,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(!authRequired);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!authRequired) return;
    const supabase = createClient();
    let active = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setReady(true);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      setReady(true);
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    ready,
    session,
    profile: session ? toAuthProfile(session.user) : authRequired ? null : {
      id: "local-development",
      email: "",
      displayName: "Local development",
      access: "superadmin",
    },
    signOut: async () => {
      if (authRequired) await createClient().auth.signOut();
    },
  }), [ready, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
