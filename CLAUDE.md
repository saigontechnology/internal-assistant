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
- **`sharepoint-list/`** — the **list watcher** feature. Each `DistributionList` row names a target SharePoint list by URL; the watcher dereferences it and syncs its rows into `Resource`. Rows are managed from the admin portal — see "SharePoint list watcher" below.
- **`user-permission/`** — job-profile ingest (title + department) driving role-based access to documents. Weekly resync via `USER_SYNC_INTERVAL_DAYS`; while a user's own profile is mid-scan or unknown, the chat filter falls back to `DEFAULT_JOB_TITLE` / `DEFAULT_DEPARTMENT`.
- **`admin/`** — the `/api/admin/*` surface behind `AdminGuard`: user management, document management, CRUD over the distribution lists, the OpenCode chat-model picker, and the runtime-settings page. See "Admin portal" below.
- **`settings/`** — `RuntimeSettingsService`: admin-editable config backed by `app_settings`, served from an in-memory snapshot (refreshed on write and every 30s). It **shadows `AppConfig`** — every getter falls back to the env var when no override row exists, so an empty table behaves exactly like the env-only build. Consumers inject `RuntimeSettingsService`, not `AppConfig`, for anything in `setting-defs.ts`. The snapshot exists because callers (`documents.service.ts` while chunking, `chat.service.ts` while resolving a model) read these values **synchronously** deep in request handling; making them async would be a large refactor for values that change a few times a year.
- **`prisma/`** — the `PrismaService`, plus the schema at `backend/prisma/schema.prisma`.

### Chat provider switch

`CHAT_PROVIDER` (env) picks the chat/generation client — `openai` (default, actually points at OpenRouter — see below), `gemini` (`@ai-sdk/google`), or `opencode` (opencode.ai gateway via `@ai-sdk/openai` with a custom `baseURL`). **Only chat is switched**; the embeddings pipeline always uses the OpenRouter-backed OpenAI client regardless of the switch, because re-embedding the corpus would invalidate the pgvector index.

For gemini and opencode, `chat.service.ts` walks a **fallback ladder** (primary → first → second) with per-model 60s cooldowns triggered by 429s. `resolveChatModel()` picks the first non-cooling rung; `handleStreamError()` arms the cooldown for the exact model that just streamed. See `docs/gemini-migration-plan.md` and `docs/opencode-migration-plan.md`.

The **OpenCode ladder is admin-editable at runtime** and the env vars are only a fallback. `app_settings` rows (`opencode.chat_model`, `.chat_fallback_model`, `.chat_second_fallback_model`, `.model_prefix`) win over the defaults whenever they exist. A ladder rung with no row falls back to its `OPENCODE_CHAT_*_MODEL` env var; the prefix falls back to the `DEFAULT_OPENCODE_MODEL_PREFIX` code constant (`opencode-go`) — it has no env var, since the gateway's namespace is the same in every deployment. `ChatSettingsService` caches the resolved config for 30s, so a save takes effect on new chats within that window. Admins pick from the live catalog at `/admin/chat-model`, and the write path validates every rung against it. The Gemini ladder is still env-only.

**Model id trap**: OpenCode's catalog (`GET $OPENCODE_API_BASE/models`, servable unauthenticated) returns **bare** ids — `glm-5.2`, `kimi-k2.6`, `minimax-m3`. The gateway, however, wants them namespaced (`opencode-go/glm-5.2`). So the **prefix is stored separately** from the model ids: `applyPrefix()` joins them at call time, catalog validation compares the *bare* id, and changing the prefix never invalidates the picked models. Never store a prefixed id in a ladder rung — it will fail catalog validation. (The original env defaults hardcoded a wrong prefix, `zai/glm-5.2`, on all three rungs.)

**Historical naming trap**: `OPENAI_API_BASE` defaults to `https://openrouter.ai/api/v1` and `CHAT_MODEL` / `EMBEDDING_MODEL` are OpenRouter slugs. "OpenAI" in this repo has meant "OpenRouter" for a while. `OPENAI_HOST_OVERRIDE` is a workaround for a self-hosted 9router proxy that gates on the `Host` header — leave it unset in local dev.

### Vector storage

`Resource` → many `Embedding` (Prisma, `ON DELETE CASCADE`). `Embedding.embedding` is declared `Unsupported("halfvec(2048)")` — the HNSW index (`embeddings_hnsw_idx`, `halfvec_cosine_ops`) lives in a hand-written migration (`migrations/20260609000001_pgvector_hnsw/`) because Prisma migrate can't express `USING hnsw (col halfvec_cosine_ops)`. If you touch the embedding column or index, edit that hand-written migration; don't let `prisma migrate` regenerate it.

Vector dimension is `2048` because the current embedding model (`nvidia/llama-nemotron-embed-vl-1b-v2:free` on OpenRouter) outputs 2048-dim vectors. Changing the embedding model to one with a different dimension requires a corpus re-embed AND changing the column type + rebuilding the HNSW index.

### Frontend

React 19 + Vite + shadcn/ui + Tailwind v4. Chat UI uses `@ai-sdk/react` `useChat`, which consumes the native UI message stream produced by the backend's `streamText` — no manual event framing. MSAL runs on the client for sign-in; the token is passed to the backend for delegated Graph calls. `vite.config.ts` proxies `/api/*` to `:8000` to avoid CORS in dev.

### SharePoint list watcher (subtle bit)

Documents are not uploaded manually — they're synced from SharePoint. **The `distribution_lists` table is the source of truth**: each row holds a `listUrl` pointing at a target SharePoint list, and that list's rows become `Resource` rows in Postgres. `list-watcher.service.ts` walks the enabled rows, dereferences each `listUrl` to a `(siteId, targetListId)` pair (cached on the row), and fans out to per-list sync. `SHAREPOINT_REGISTRY_INCREMENTAL_WINDOW_DAYS>0` enables incremental fetch based on `lastModifiedDateTime`; `0` means full sync each run (current default).

Rows are managed at `/admin/links`. **A fresh database syncs nothing until an admin adds a list** (or runs `POST /api/admin/distribution-lists/import-registry` once). This replaced an older design where a SharePoint **registry list** (`SHAREPOINT_LIST_NAME`, default `Document Distribution List`) was walked on every sync and each of its rows became a `DistributionList` row. That env var now only feeds the one-shot import endpoint; `distribution_lists.registry_list_id` / `registry_item_id` survive as nullable provenance columns. `docs/multi-list-watcher-plan.md` describes the old design.

Two traps when touching the sync path:
- `liveTargetListIds()` (the input to `demoteOrphanedSharepointRows`) must be derived from **stored** `targetListId`s of enabled rows — never from "what this run resolved". Both `ListWatcherService` and `JobProfileSyncService` call it. Building it from per-run results means a transient Graph failure, or a job-profile scan run by a user who lacks access to a site, silently demotes every resource in that list.
- `JobProfileSyncService` no longer bootstraps `distribution_lists` from the registry on first login; it reads them and skips rows with an unresolved target.

Files may be indexed as **metadata-only** (`syncStatus=pending_access`) when the current syncing user can't resolve the file — permissions get retried on future syncs. Do not assume `Resource` rows always have embeddings.

### Admin portal

Frontend at `/admin/*` (react-router; the chat app stays mounted at `*` and is untouched). Backend at `/api/admin/*`, every controller behind `AdminGuard`.

`UserPermission.role` (`admin` | `user`) is the only role concept. Bootstrap with `ADMIN_EMAILS` (comma-separated) — those emails are promoted at boot and on login. **Promotion is one-way**: dropping someone from `ADMIN_EMAILS` does not demote them. The boot-time promotion deliberately does *not* create rows, because `user_permissions.email` keeps MSAL's mixed-case UPN while `ADMIN_EMAILS` is lowercased — creating a row would produce a second row for the same human. Users who've never signed in get promoted on first login instead.

Two other invariants worth knowing:
- `UserPermission.profileOverride` — when an admin pins a `(jobTitle, department)`, `UserPermissionService.upsertProfile` (the sole Azure AD write path) leaves the normalized join keys alone so the override survives login and the weekly resync.
- `UserPermission.isActive` — `SessionGuard` checks it on every authed request and deletes the session when false; `AuthService.completeLogin` rejects at the door. A missing `user_permissions` row means "active" (first-login users).

`GET /api/documents` is now authenticated (was `@Public()`); `POST /api/documents/upload` and `DELETE /api/documents/:id` are admin-only.

**Runtime settings** (`/admin/settings`, `SETTING_DEFS` in `settings/setting-defs.ts`). Adding a setting means adding one registry entry plus one getter on `RuntimeSettingsService` — the controller and the form are generic. Three classes of var deliberately stay env-only, and the registry's doc comment says why: `EMBEDDING_MODEL` (a different output dimension silently corrupts the `halfvec(2048)` column rather than erroring), anything read in a constructor (`CHAT_PROVIDER` and the API base URLs — ChatService builds its SDK clients once), and every secret. The read-only "Environment" panel resolves non-secrets through `AppConfig` rather than `process.env`, because Zod's defaults are never written back to `process.env`; secrets are masked server-side and `REDIS_URL`'s userinfo is stripped.

### Auth model

MSAL delegated auth (Entra ID). Backend reads `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`; frontend reads `VITE_AZURE_CLIENT_ID` / `VITE_AZURE_TENANT_ID`. Sessions are cookie-based (signed with `SESSION_SECRET`). `session.lastAzureCheckAt` throttles Azure re-validation on each request.

## Key docs

Under `docs/`:
- `setup.md` — Neon + Entra ID app registration walkthrough
- `api.md` — HTTP endpoint reference (predates `/api/admin/*`)
- `role-based-access-plan.md` — job-profile driven access filtering
- `stream-resumption-plan.md` — Redis-backed resumable chat SSE
- `multi-list-watcher-plan.md` — ⚠️ describes the retired SharePoint-registry design; the DB now owns distribution lists
- `gemini-migration-plan.md` / `opencode-migration-plan.md` — chat-provider switch design
