"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { authRequired } from "@/lib/auth-mode";
import { createClient } from "@/lib/supabase/client";
import { AccessLevel, AuthProfile, fetchAccessLevel, toAuthProfile } from "@/lib/auth";

type AuthContextValue = {
  ready: boolean;
  session: Session | null;
  profile: AuthProfile | null;
  signOut: () => Promise<void>;
};

const LOCAL_PROFILE: AuthProfile = {
  id: "local-development",
  email: "",
  displayName: "Local development",
  access: "superadmin",
};

const AuthContext = createContext<AuthContextValue>({
  ready: !authRequired,
  session: null,
  profile: authRequired ? null : LOCAL_PROFILE,
  signOut: async () => undefined,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // `ready` means the session is bootstrapped AND crm.users.role has been
  // resolved for it, so the gate never briefly renders "access required" while
  // the role lookup is still in flight.
  const [ready, setReady] = useState(!authRequired);
  const [session, setSession] = useState<Session | null>(null);
  const [access, setAccess] = useState<AccessLevel | null>(null);

  useEffect(() => {
    if (!authRequired) return;
    const supabase = createClient();
    let active = true;
    // The role for the session we've already resolved; lets a token refresh for
    // the same user re-check in the background without flashing the gate.
    let resolvedUserId: string | null = null;

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      if (nextSession && nextSession.user.id !== resolvedUserId) setReady(false);

      // Defer the RPC out of the callback: calling the supabase client from
      // inside onAuthStateChange can deadlock its internal lock.
      setTimeout(() => {
        if (!active) return;
        if (!nextSession) {
          resolvedUserId = null;
          setAccess(null);
          setReady(true);
          return;
        }
        void fetchAccessLevel(supabase).then((level) => {
          if (!active) return;
          resolvedUserId = nextSession.user.id;
          setAccess(level);
          setReady(true);
        });
      }, 0);
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    ready,
    session,
    profile: session ? toAuthProfile(session.user, access) : authRequired ? null : LOCAL_PROFILE,
    signOut: async () => {
      if (authRequired) await createClient().auth.signOut();
    },
  }), [ready, session, access]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
