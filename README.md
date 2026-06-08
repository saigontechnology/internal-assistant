# Internal Assistant

AI-powered document chatbot. Import documents from SharePoint and ask questions — Internal Assistant retrieves relevant content and generates answers using RAG.

## Architecture

- **Backend**: Node.js + Hono + Vercel AI SDK + Drizzle ORM
- **Frontend**: React (Vite) + shadcn/ui + Vercel AI SDK
- **Vector DB**: Neon Postgres + pgvector (`halfvec` with HNSW index)
- **Documents**: Microsoft SharePoint via Graph API
- **Auth**: MSAL (Microsoft Entra ID, delegated)
- **AI Provider**: OpenAI-compatible API (configurable)

## Prerequisites

- Node.js 18+
- A Neon Postgres database with the `pgvector` extension enabled
- An OpenAI-compatible API key
- A Microsoft Entra ID app registration (see [setup docs](docs/setup.md))

## Quick Start

### 1. Provision Neon

Create a project at [neon.tech](https://neon.tech), enable the `vector` extension, and copy the pooled connection string into `backend/.env` as `DATABASE_URL`.

### 2. Backend

```bash
cd backend
cp .env.example .env
# Edit .env with your API key and Azure credentials

npm install
npm run db:migrate   # apply Drizzle migrations (creates resources + embeddings tables)
npm run dev
```

### 3. Frontend

```bash
cd frontend
cp .env.example .env
# Edit .env with your Azure client ID and tenant ID

npm install
npm run dev
```

Open http://localhost:5173 — sign in with your Microsoft account and import documents from SharePoint.

### Run everything at once

Once dependencies are installed and `.env` files are configured, start the whole
stack — the 9router AI proxy (`:20128`), backend (`:8000`), frontend (`:5173`),
and a Claude Code pane — in a tmux session with a single command from the repo root:

```bash
./dev.sh
```

The session uses the project `.tmux.conf` (labeled pane borders, mouse support,
violet status bar). Re-running the script attaches to the existing session.

- Detach (leave everything running): `Ctrl-b d`
- Switch panes: click, `Option+arrow`, or `Ctrl-b h/j/k/l`
- Stop everything: `tmux kill-session -t internal-assistant`

Requires `tmux` (`brew install tmux`).

## Configuration

### Backend (`backend/.env`)

| Variable             | Description          | Default                        |
| -------------------- | -------------------- | ------------------------------ |
| `OPENAI_API_BASE`    | AI API base URL      | `https://openrouter.ai/api/v1` |
| `OPENAI_API_KEY`     | API key              | —                              |
| `CHAT_MODEL`         | Chat model name      | `deepseek/deepseek-v4-flash:free` |
| `EMBEDDING_MODEL`    | Embedding model      | `nvidia/llama-nemotron-embed-vl-1b-v2:free` |
| `DATABASE_URL`       | Neon Postgres URL    | —                              |
| `AZURE_CLIENT_ID`    | Azure app client ID  | —                              |
| `AZURE_TENANT_ID`    | Azure tenant ID      | —                              |
| `AZURE_CLIENT_SECRET`| Azure client secret  | —                              |

### Frontend (`frontend/.env`)

| Variable               | Description          |
| ---------------------- | -------------------- |
| `VITE_AZURE_CLIENT_ID` | Azure app client ID  |
| `VITE_AZURE_TENANT_ID` | Azure tenant ID      |

## Supported File Types

PDF, TXT, Markdown, DOCX, CSV, XLSX
