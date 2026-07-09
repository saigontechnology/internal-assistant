# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package manager

Use **npm** for both `backend/` and `frontend/`. Do not run `pnpm install` — the backend contains a stale `pnpm-lock.yaml` and `pnpm-workspace.yaml` from an earlier era; the source of truth is `package-lock.json` in each project and at the repo root. `pnpm install` will move real deps into `node_modules/.ignored` and break the app.

## Common commands

Run these from `backend/` or `frontend/` respectively.

**Backend** (NestJS + Prisma):
- `npm run dev` — tsx watch on `src/main.ts`, listens on `:8000` (global prefix `/api`)
- `npm run build` — `prisma generate && tsc` into `dist/`
- `npm start` — run compiled server from `dist/src/main.js`
- `npm run db:migrate` — apply Prisma migrations against `DATABASE_URL`
- `npm run prisma:generate` — regenerate the Prisma client only
- `npm run db:studio` — open Prisma Studio
- `npm run db:reset-sync` — wipe & regenerate sync state via `scripts/reset-sync-data.ts`

There is **no test runner** and **no linter** wired in the backend yet. Rely on `tsc --noEmit` (via `npm run build`) for type checking.

**Frontend** (Vite + React 19):
- `npm run dev` — Vite dev server on `:5173`, proxies `/api/*` to `:8000`
- `npm run build` — `tsc -b && vite build`
- `npm run lint` — ESLint
- `npm run preview` — serve the production build locally

**Whole stack**: `./dev.sh` from the repo root launches a tmux session with 9router (`:20128`), backend, frontend, and a Claude pane. Requires `tmux` and starts the local Postgres via `docker-compose.yml` if not already running.

## Architecture (big picture)

> ⚠️ `docs/architecture.md` is out of date — it describes an earlier Hono + Drizzle version. The current backend is **NestJS + Prisma**. Prefer the code and this file over that doc.

### Backend layout (NestJS modules under `backend/src/`)

Each subdirectory is a Nest module wired in `app.module.ts`:

- **`config/`** — env schema (Zod, `env.schema.ts`), typed `AppConfig` wrapper, and provider client factories (`openai-client.ts`, `google-client.ts`, `opencode-client.ts`). All chat/LLM clients are constructed here.
- **`auth/`** — MSAL confidential-client flow (Microsoft Entra ID). Cookies signed with `SESSION_SECRET`; `cookie-parser` is registered in `main.ts`.
- **`chat/`** — the RAG chat agent. `chat.service.ts` owns the LLM client, tool definitions, per-model 429 cooldowns, and the `CHAT_PROVIDER` ladder. `resumable-stream.service.ts` + `active-stream-registry.ts` back the resumable SSE contract (Redis-backed) so `GET /api/chat/:id/stream` can resume mid-stream after a client reconnect.
- **`documents/`** — parsing (PDF, DOCX, XLSX, CSV, TXT, MD, OCR via `tesseract.js`), chunking (`text-splitter.ts`), and the `retrieveResources` / `listDocuments` tools exposed to the LLM (`document-tools.ts`).
- **`embeddings/`** — writes and queries the `halfvec(2048)` vector column. All reads/writes go through raw SQL (`prisma.$queryRaw`) because Prisma has no first-class pgvector type.
- **`sharepoint/`** — Graph API wrapper for browsing sites/drives/files.
- **`sharepoint-list/`** — the **list watcher** feature. A **registry list** in SharePoint (default name `Document Distribution List`) maps human list names → target list URLs; every registry row becomes a `DistributionList` row and its `Link` column dereferences to the real list we sync. See `docs/multi-list-watcher-plan.md`.
- **`user-permission/`** — job-profile ingest (title + department) driving role-based access to documents. Weekly resync via `USER_SYNC_INTERVAL_DAYS`; while a user's own profile is mid-scan or unknown, the chat filter falls back to `DEFAULT_JOB_TITLE` / `DEFAULT_DEPARTMENT`.
- **`prisma/`** — the `PrismaService`, plus the schema at `backend/prisma/schema.prisma`.

### Chat provider switch

`CHAT_PROVIDER` (env) picks the chat/generation client — `openai` (default, actually points at OpenRouter — see below), `gemini` (`@ai-sdk/google`), or `opencode` (opencode.ai gateway via `@ai-sdk/openai` with a custom `baseURL`). **Only chat is switched**; the embeddings pipeline always uses the OpenRouter-backed OpenAI client regardless of the switch, because re-embedding the corpus would invalidate the pgvector index.

For gemini and opencode, `chat.service.ts` walks a **fallback ladder** (primary → first → second) with per-model 60s cooldowns triggered by 429s. `resolveChatModel()` picks the first non-cooling rung; `handleStreamError()` arms the cooldown for the exact model that just streamed. See `docs/gemini-migration-plan.md` and `docs/opencode-migration-plan.md`.

**Historical naming trap**: `OPENAI_API_BASE` defaults to `https://openrouter.ai/api/v1` and `CHAT_MODEL` / `EMBEDDING_MODEL` are OpenRouter slugs. "OpenAI" in this repo has meant "OpenRouter" for a while. `OPENAI_HOST_OVERRIDE` is a workaround for a self-hosted 9router proxy that gates on the `Host` header — leave it unset in local dev.

### Vector storage

`Resource` → many `Embedding` (Prisma, `ON DELETE CASCADE`). `Embedding.embedding` is declared `Unsupported("halfvec(2048)")` — the HNSW index (`embeddings_hnsw_idx`, `halfvec_cosine_ops`) lives in a hand-written migration (`migrations/20260609000001_pgvector_hnsw/`) because Prisma migrate can't express `USING hnsw (col halfvec_cosine_ops)`. If you touch the embedding column or index, edit that hand-written migration; don't let `prisma migrate` regenerate it.

Vector dimension is `2048` because the current embedding model (`nvidia/llama-nemotron-embed-vl-1b-v2:free` on OpenRouter) outputs 2048-dim vectors. Changing the embedding model to one with a different dimension requires a corpus re-embed AND changing the column type + rebuilding the HNSW index.

### Frontend

React 19 + Vite + shadcn/ui + Tailwind v4. Chat UI uses `@ai-sdk/react` `useChat`, which consumes the native UI message stream produced by the backend's `streamText` — no manual event framing. MSAL runs on the client for sign-in; the token is passed to the backend for delegated Graph calls. `vite.config.ts` proxies `/api/*` to `:8000` to avoid CORS in dev.

### SharePoint list watcher (subtle bit)

Documents are not uploaded manually — they're synced from SharePoint. The **registry list** is a SharePoint list of lists: each row's `Link` column points at a *target* SharePoint list, and each target list's rows become `Resource` rows in Postgres. `list-watcher.service.ts` periodically walks the registry, resolves each link, and fans out to per-list sync. `SHAREPOINT_REGISTRY_INCREMENTAL_WINDOW_DAYS>0` enables incremental fetch based on `lastModifiedDateTime`; `0` means full sync each run (current default).

Files may be indexed as **metadata-only** (`syncStatus=pending_access`) when the current syncing user can't resolve the file — permissions get retried on future syncs. Do not assume `Resource` rows always have embeddings.

### Auth model

MSAL delegated auth (Entra ID). Backend reads `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`; frontend reads `VITE_AZURE_CLIENT_ID` / `VITE_AZURE_TENANT_ID`. Sessions are cookie-based (signed with `SESSION_SECRET`). `session.lastAzureCheckAt` throttles Azure re-validation on each request.

## Key docs

Under `docs/`:
- `setup.md` — Neon + Entra ID app registration walkthrough
- `api.md` — HTTP endpoint reference
- `role-based-access-plan.md` — job-profile driven access filtering
- `stream-resumption-plan.md` — Redis-backed resumable chat SSE
- `multi-list-watcher-plan.md` — SharePoint registry list design
- `gemini-migration-plan.md` / `opencode-migration-plan.md` — chat-provider switch design
