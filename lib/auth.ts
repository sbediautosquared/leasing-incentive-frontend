import type { User } from "@supabase/supabase-js";

export type AccessLevel = "superadmin";

export type AuthProfile = {
  id: string;
  email: string;
  displayName: string;
  access: AccessLevel | null;
};

function isSuperAdminClaim(value: unknown): boolean {
  return value === "superadmin" || value === "super_admin";
}

export function hasSuperAdminAccess(user: User): boolean {
  const metadata = user.app_metadata ?? {};
  const roleClaims = Array.isArray(metadata.roles) ? metadata.roles : [];
  return isSuperAdminClaim(metadata.access)
    || isSuperAdminClaim(metadata.role)
    || isSuperAdminClaim(metadata.lease_role)
    || roleClaims.some(isSuperAdminClaim);
}

export function toAuthProfile(user: User): AuthProfile {
  const metadata = user.user_metadata ?? {};
  const displayName = typeof metadata.full_name === "string"
    ? metadata.full_name
    : typeof metadata.name === "string"
      ? metadata.name
      : user.email ?? "Lease Ledger user";

  return {
    id: user.id,
    email: user.email ?? "",
    displayName,
    access: hasSuperAdminAccess(user) ? "superadmin" : null,
  };
}
