"use client";

import { useAuth } from "@/components/auth-provider";
import { SignOutButton } from "@/components/sign-out-button";
import { authRequired, isDevServer } from "@/lib/auth-mode";

function initials(name: string | undefined) {
  if (!name) return "•";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "•";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function HeaderAccount() {
  const { profile } = useAuth();

  // Open-access mode (auth disabled). The "Local development" indicator is a
  // dev convenience, so only show it while the dev server is running.
  if (!authRequired) {
    if (!isDevServer) return null;
    return (
      <div className="header-account">
        <span className="env-badge" title="Authentication is disabled for local development">
          <span className="env-badge-dot" aria-hidden="true" />
          Local development
        </span>
      </div>
    );
  }

  if (!profile) return <div className="header-account" />;

  return (
    <div className="header-account">
      <div className="account-identity">
        <span className="account-avatar" aria-hidden="true">{initials(profile.displayName)}</span>
        <span className="account-name" title={profile.displayName}>{profile.displayName}</span>
      </div>
      <SignOutButton />
    </div>
  );
}
