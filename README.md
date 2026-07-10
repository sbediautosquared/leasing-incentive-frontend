# Lease Ledger — Web

Next.js frontend for [Lease Ledger](../README.md): upload lease residual PDFs, track
import status, and review standardized rows with search, sort, and export links.

The UI talks to the Python API through a same-origin `/api/*` proxy. In local
development that proxy is implemented by `app/api/[...path]/route.ts`; in the
Docker stack Nginx routes `/api/*` directly to the API service.

## Prerequisites

- [Node.js](https://nodejs.org/) 22+ (matches the Docker image)
- [pnpm](https://pnpm.io/) (enabled via Corepack: `corepack enable`)
- The Lease Ledger API running locally on port **8000** — see the [root README](../README.md#run-locally)

## Run locally

From this directory:

```sh
pnpm install
pnpm dev
```

Open http://localhost:3000.

With the default configuration, authentication is disabled and the workspace is
open. Start the API in a separate terminal before uploading files:

```sh
# from the repository root
uv sync --extra api
.venv/bin/uvicorn backend.app:app --reload --port 8000
```

## Environment variables

Create `web/.env.local` (gitignored) when you need to override defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_ORIGIN` | `http://localhost:8000` | Upstream FastAPI base URL for the Next.js `/api` proxy |
| `NEXT_PUBLIC_AUTH_MODE` | *(unset → disabled)* | Set to `supabase` to require sign-in |
| `NEXT_PUBLIC_SUPABASE_URL` | — | Supabase project URL (required when auth is on) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | — | Supabase anon key (required when auth is on) |

`NEXT_PUBLIC_*` values are inlined into the client bundle at **build** time.

### Authentication (optional, dev)

By default the app is open for local development. To test Supabase login, copy the
Microsites Supabase URL and anon key into `.env.local` and set
`NEXT_PUBLIC_AUTH_MODE=supabase`. Only accounts with a **superadmin** claim in
`app_metadata` can use the import workspace.

See [docs/SHARED_SUPABASE_AUTH.md](../docs/SHARED_SUPABASE_AUTH.md) for the full
auth design and safety rails.

Example `.env.local`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
NEXT_PUBLIC_AUTH_MODE=supabase
```

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the Next.js dev server (port 3000) |
| `pnpm build` | Production build |
| `pnpm start` | Serve the production build |
| `pnpm lint` | Run ESLint |

## Project layout

```text
app/
  page.tsx              Main workspace — import rail + review table
  login/page.tsx        Supabase sign-in (when auth is enabled)
  api/[...path]/route.ts  Proxies /api/* to the Python backend
components/
  auth-gate.tsx         Redirects unauthenticated users to /login
  auth-provider.tsx     Supabase session + profile context
lib/
  api.ts                fetch wrapper that attaches the session token
  auth.ts               Superadmin access checks
  auth-mode.ts          `authRequired` flag from NEXT_PUBLIC_AUTH_MODE
  supabase/client.ts    Browser Supabase client
```

Styling is hand-written CSS in `app/globals.css` — no component library.

## Docker

Build and run the production image from this directory:

```sh
docker build -t lease-ledger-web .
docker run --rm -p 3000:3000 \
  -e API_ORIGIN=http://host.docker.internal:8000 \
  lease-ledger-web
```

Pass build args to enable Supabase auth in the image:

```sh
docker build \
  --build-arg NEXT_PUBLIC_AUTH_MODE=supabase \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key> \
  -t lease-ledger-web .
```

For the full multi-service stack (API, worker, Redis, Nginx), use the root
[docker-compose.yml](../docker-compose.yml) or see [docs/DEPLOY.md](../docs/DEPLOY.md).

## Related docs

- [Root README](../README.md) — parsers, data layout, local containers
- [docs/DEPLOY.md](../docs/DEPLOY.md) — CI/CD to the DigitalOcean droplet
- [docs/SHARED_SUPABASE_AUTH.md](../docs/SHARED_SUPABASE_AUTH.md) — shared Microsites credentials
