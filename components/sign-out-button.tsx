"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { authRequired } from "@/lib/auth-mode";

export function SignOutButton() {
  const router = useRouter();
  const { signOut } = useAuth();
  if (!authRequired) return null;

  return <button className="sign-out" type="button" onClick={() => void signOut().then(() => router.replace("/login"))}>Sign out</button>;
}

