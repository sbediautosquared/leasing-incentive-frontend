import type { SupabaseClient, User } from "@supabase/supabase-js";

export type AccessLevel = "superadmin";

export type AuthProfile = {
  id: string;
  email: string;
  displayName: string;
  access: AccessLevel | null;
};

// Roles as stored in crm.users.role. Normalized so casing/whitespace can't
// silently deny access, and both spellings map to the same level so a legacy
// "super_admin" row still grants access.
export function accessLevelFromRole(role: string | null | undefined): AccessLevel | null {
  const normalized = role?.trim().toLowerCase();
  return normalized === "superadmin" || normalized === "super_admin" ? "superadmin" : null;
}

// The source of truth for access is crm.users.role. crm.current_lease_role()
// (SECURITY DEFINER) returns the calling user's own role for that column; see
// supabase/migrations/202607100001_lease_role_rpc.sql. Works with any Supabase
// client bound to the user's session — browser or the server-side proxy.
export async function fetchAccessLevel(supabase: SupabaseClient): Promise<AccessLevel | null> {
  const { data, error } = await supabase.schema("crm").rpc("current_lease_role");
  if (error) return null;
  return accessLevelFromRole(typeof data === "string" ? data : null);
}

export function toAuthProfile(user: User, access: AccessLevel | null): AuthProfile {
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
    access,
  };
}
