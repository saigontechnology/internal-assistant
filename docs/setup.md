# Setup & Configuration

## Prerequisites

- Node.js 18+
- A Neon Postgres database with the `pgvector` extension enabled
- An OpenAI-compatible API key (OpenAI, OpenRouter, etc.)
- A Microsoft Entra ID (Azure AD) app registration

## Azure App Registration

Register an app in the [Azure portal](https://portal.azure.com):

1. Go to **Microsoft Entra ID** > **App registrations** > **New registration**
2. Set **Redirect URI** to `http://localhost:5173` (Single-page application)
3. Under **API permissions**, add delegated permissions:
   - `Sites.Read.All`
   - `Files.Read.All`
4. Under **Certificates & secrets**, create a client secret
5. Note the **Application (client) ID** and **Directory (tenant) ID**

## Quick Start

### 1. Neon Postgres

1. Create a project at [neon.tech](https://neon.tech).
2. In the SQL editor, enable pgvector:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. Copy the **pooled** connection string (with `?sslmode=require`) — this is your `DATABASE_URL`.

> The schema uses `halfvec(2048)` with an HNSW cosine index. If your embedding model produces a different dimension, update `EMBEDDING_DIM` in `src/db/schema.ts` and regenerate migrations.

### 2. Backend

```bash
cd backend
cp .env.example .env
# Edit .env with your DATABASE_URL, API key, and Azure credentials

npm install
npm run db:migrate   # apply Drizzle migrations
npm run dev
```

#### Drizzle commands

| Command              | Description                                         |
| -------------------- | --------------------------------------------------- |
| `npm run db:generate`| Generate a new migration from schema changes        |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL`          |
| `npm run db:studio`  | Open Drizzle Studio to browse the database          |

### 3. Frontend

```bash
cd frontend
cp .env.example .env
# Edit .env with your Azure client ID and tenant ID

npm install
npm run dev
```

Open http://localhost:5173 — the Vite dev server proxies `/api` requests to the backend.

---

## Environment Variables

### Backend (`backend/.env`)

| Variable             | Description                        | Default                          |
| -------------------- | ---------------------------------- | -------------------------------- |
| `OPENAI_API_BASE`    | LLM / embedding API base URL      | `https://openrouter.ai/api/v1`  |
| `OPENAI_API_KEY`     | API key for the AI provider        | *(required)*                     |
| `CHAT_MODEL`         | Chat completion model name         | `deepseek/deepseek-v4-flash:free` |
| `EMBEDDING_MODEL`    | Embedding model name               | `nvidia/llama-nemotron-embed-vl-1b-v2:free` |
| `CHUNK_SIZE`         | Text splitter chunk size (chars)   | `1000`                          |
| `CHUNK_OVERLAP`      | Text splitter overlap (chars)      | `200`                           |
| `DATABASE_URL`       | Neon Postgres connection string    | *(required)*                     |
| `AZURE_CLIENT_ID`    | Azure app client ID                | *(required)*                     |
| `AZURE_TENANT_ID`    | Azure tenant ID                    | *(required)*                     |
| `AZURE_CLIENT_SECRET`| Azure app client secret            | *(required)*                     |
| `AZURE_REDIRECT_URI` | OAuth redirect URI                 | `http://localhost:5173`          |

### Frontend (`frontend/.env`)

| Variable                 | Description            | Default                  |
| ------------------------ | ---------------------- | ------------------------ |
| `VITE_AZURE_CLIENT_ID`   | Azure app client ID    | *(required)*             |
| `VITE_AZURE_TENANT_ID`   | Azure tenant ID        | *(required)*             |
| `VITE_AZURE_REDIRECT_URI`| OAuth redirect URI     | `http://localhost:5173`  |

---

## Supported File Types

Documents imported from SharePoint are parsed using these libraries:

| Extension | Parser Used  |
| --------- | ------------ |
| `.pdf`    | pdf-parse    |
| `.txt`    | Native fs    |
| `.md`     | Native fs    |
| `.docx`   | mammoth      |
| `.csv`    | csv-parse    |
| `.xlsx`   | xlsx         |

---

## Development

### Backend

```bash
cd backend
npm run dev    # Dev server with hot reload (tsx watch)
npm run build  # Compile TypeScript
npm start      # Run compiled output
```

### Frontend

```bash
cd frontend
npm run dev     # Dev server on :5173
npm run build   # Production build → dist/
npm run preview # Preview production build
npm run lint    # ESLint
```

### Dev Proxy

Vite is configured to proxy `/api/*` requests to `http://localhost:8000`:

```ts
// vite.config.ts
server: {
  proxy: {
    "/api": {
      target: "http://localhost:8000",
      changeOrigin: true,
    },
  },
}
```

---

## Data Storage

All document metadata, chunk text, and vectors live in Neon Postgres:

| Table         | Contents                                                          |
| ------------- | ----------------------------------------------------------------- |
| `resources`   | One row per imported document (id, filename, file type, source)   |
| `embeddings`  | One row per chunk (content, `halfvec(2048)` embedding, metadata)  |

Foreign key `embeddings.resource_id → resources.id` uses `ON DELETE CASCADE`, so deleting a resource removes its chunks. Retrieval uses the HNSW index on `embeddings.embedding` with `halfvec_cosine_ops`.

To reset all indexed data:

```sql
TRUNCATE TABLE embeddings, resources;
```

Or drop and re-run migrations:

```bash
npm run db:migrate
```

---

## Production Considerations

- **CORS** — Currently hardcoded to `http://localhost:5173`; update for your domain
- **Reverse proxy** — Use Nginx or similar to serve the frontend and proxy `/api` to the backend
- **Database** — Use a production Neon branch (or any Postgres with pgvector ≥ 0.7 for `halfvec`); use the pooled connection string for serverless workloads
- **Rate limiting** — Add request rate limiting to prevent abuse
- **Logging** — Add structured logging for observability
- **Azure permissions** — Ensure the app registration has admin consent for the required Graph API scopes
