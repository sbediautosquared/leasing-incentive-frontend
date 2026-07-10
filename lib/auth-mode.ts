export const authRequired = process.env.NEXT_PUBLIC_AUTH_MODE === "supabase";

// True only while the Next dev server is running (`pnpm run dev`); a production
// build/`next start` compiles this to `false`. Used to surface the
// "Local development" indicator without leaking it into production.
export const isDevServer = process.env.NODE_ENV === "development";

