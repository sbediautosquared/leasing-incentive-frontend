import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { authRequired } from "@/lib/auth-mode";
import { hasSuperAdminAccess } from "@/lib/auth";

const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:8000";
// Shared secret proving this request came from the trusted server-side proxy.
// The droplet's nginx requires it on /leasing-admin/, so the admin API is not
// publicly usable. Unset locally (the dev backend is hit directly, no gate).
const apiProxySecret = process.env.API_PROXY_SECRET;

type RouteContext = { params: Promise<{ path: string[] }> };

async function handler(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const target = `${apiOrigin}/api/${path.join("/")}${new URL(request.url).search}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  if (apiProxySecret) headers.set("X-Lease-Admin-Secret", apiProxySecret);

  const cookiesToSet: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  if (authRequired) {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll: (cookies) => { cookiesToSet.push(...cookies); },
        },
      },
    );
    const { data: userData, error: userError } = await supabase.auth.getUser();
    const { data: sessionData } = await supabase.auth.getSession();
    if (userError || !userData.user || !sessionData.session) {
      return NextResponse.json({ detail: "Authentication required." }, { status: 401 });
    }
    if (!hasSuperAdminAccess(userData.user)) return NextResponse.json({ detail: "Superadmin access required." }, { status: 403 });
    headers.set("Authorization", `Bearer ${sessionData.session.access_token}`);
  }

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const response = await fetch(target, { method: request.method, headers, body, cache: "no-store" });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  const nextResponse = new NextResponse(response.body, { status: response.status, headers: responseHeaders });
  for (const cookie of cookiesToSet) nextResponse.cookies.set(cookie.name, cookie.value, cookie.options as never);
  return nextResponse;
}

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
