# Architecture

Internal Assistant is an AI-powered document chatbot built on **RAG (Retrieval-Augmented Generation)**. Users import documents from SharePoint, the system chunks and embeds them into a vector database, and questions are answered by retrieving relevant chunks and feeding them to an LLM.

## Tech Stack

| Layer              | Technology                                         |
| ------------------ | -------------------------------------------------- |
| **Frontend**       | React 19, Vite 8, TypeScript 6                     |
| **UI**             | shadcn/ui, Tailwind CSS v4, Lucide icons           |
| **Chat SDK**       | Vercel AI SDK (`@ai-sdk/react` `useChat`)          |
| **Backend**        | Node.js, Hono, TypeScript                          |
| **AI**             | Vercel AI SDK (`ai` `streamText`)                  |
| **AI Provider**    | `@ai-sdk/openai` (OpenRouter, OpenAI, Ollama)      |
| **Vector DB**      | Neon Postgres + pgvector (`halfvec` 2048, HNSW)    |
| **ORM**            | Drizzle ORM + drizzle-kit (`@neondatabase/serverless`) |
| **Document Source**| Microsoft SharePoint via Graph API                 |
| **Auth**           | MSAL (delegated, Microsoft Entra ID)               |

## Directory Structure

```
docwise/
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── drizzle.config.ts         # drizzle-kit config (points at src/db/schema.ts)
│   ├── .env.example
│   └── src/
│       ├── index.ts              # Hono app entry
│       ├── config.ts             # Env config (dotenv + zod)
│       ├── types.ts              # Shared TypeScript types
│       ├── db/
│       │   ├── index.ts          # Neon HTTP driver + Drizzle client
│       │   ├── schema.ts         # resources + embeddings (halfvec 2048, HNSW)
│       │   └── migrations/       # drizzle-kit generated SQL
│       ├── routes/
│       │   ├── chat.ts           # POST /api/chat (streamText)
│       │   ├── documents.ts      # GET/POST/DELETE /api/documents
│       │   ├── sharepoint.ts     # SharePoint browsing endpoints
│       │   └── auth.ts           # MSAL token exchange
│       ├── services/
│       │   ├── chat-service.ts       # RAG context retrieval
│       │   ├── document-service.ts   # Import from SharePoint, parse, chunk
│       │   ├── embedding-service.ts  # Embeddings + pgvector queries
│       │   └── sharepoint-service.ts # Microsoft Graph API wrapper
│       └── lib/
│           ├── parsers.ts        # PDF, DOCX, CSV, XLSX, TXT parsers
│           └── text-splitter.ts  # Recursive text chunking
│
├── frontend/
│   ├── vite.config.ts            # Vite + proxy /api → :8000
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── main.tsx              # React entry + MsalProvider
│       ├── App.tsx               # Layout shell
│       ├── lib/
│       │   ├── api.ts            # Document & SharePoint API client
│       │   ├── msal.ts           # MSAL configuration
│       │   ├── use-msal-token.ts # Token acquisition hook
│       │   └── utils.ts          # cn() helper
│       └── components/
│           ├── layout/           # Header, Sidebar
│           ├── chat/             # ChatPanel, MessageList, MessageBubble
│           ├── documents/        # SharePoint file picker, DocumentList
│           └── ui/               # shadcn primitives
│
├── docs/                         # Documentation
└── README.md
```

## System Diagram

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (React + Vite :5173)                          │
│                                                         │
│  ┌─────────┐  ┌────────────┐  ┌──────────────────────┐ │
│  │ Header  │  │  Sidebar   │  │     ChatPanel        │ │
│  │ (MSAL)  │  │ ┌────────┐ │  │ ┌──────────────────┐ │ │
│  └─────────┘  │ │SharePt │ │  │ │  MessageList     │ │ │
│               │ │Picker  │ │  │ │  (useChat hook)  │ │ │
│               │ ├────────┤ │  │ ├──────────────────┤ │ │
│               │ │Document│ │  │ │  Input + Send    │ │ │
│               │ │List    │ │  │ └──────────────────┘ │ │
│               │ └────────┘ │  └──────────────────────┘ │
│               └────────────┘                            │
└──────────────────┬──────────────────────────────────────┘
                   │  /api/*  (Vite proxy)
                   ▼
┌─────────────────────────────────────────────────────────┐
│  Backend (Hono + Node.js :8000)                         │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────────────────┐ │
│  │ routes/          │  │ services/                    │ │
│  │  chat.ts         │──│  chat-service.ts             │ │
│  │  documents.ts    │──│  document-service.ts         │ │
│  │  sharepoint.ts   │──│  sharepoint-service.ts       │ │
│  │  auth.ts         │  │  embedding-service.ts        │ │
│  └──────────────────┘  └─────────┬────────────────────┘ │
│                                  │                      │
│              ┌───────────────────┼───────────────────┐  │
│              ▼                   ▼                    ▼  │
│  ┌──────────────────┐ ┌──────────────┐ ┌─────────────┐ │
│  │ SharePoint       │ │ Neon Postgres│ │ OpenAI API  │ │
│  │ (Graph API)      │ │  + pgvector  │ │ (LLM+Embed) │ │
│  └──────────────────┘ └──────────────┘ └─────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Key Architectural Decisions

1. **Vercel AI SDK end-to-end** — The backend uses `streamText()` from the `ai` package which produces the native UI message stream that the frontend `useChat()` hook consumes directly. No manual event framing needed.

2. **SharePoint as document source** — Documents are imported from SharePoint via Microsoft Graph API using delegated (MSAL) authentication, replacing local file uploads.

3. **Neon Postgres + pgvector** — Vectors live in a managed Postgres database. The schema (`src/db/schema.ts`) has a `resources` table for document metadata and an `embeddings` table that stores chunk text alongside a `halfvec(2048)` vector. Cosine similarity is served by an HNSW index (`halfvec_cosine_ops`), and `ON DELETE CASCADE` cleans up chunks when a resource is removed. Drizzle ORM handles queries; drizzle-kit generates migrations.

4. **Delegated auth (MSAL)** — Users sign in with their Microsoft account via MSAL React. The access token is passed to the backend for Graph API calls.

5. **Provider-agnostic LLM** — Uses `@ai-sdk/openai` with configurable `baseURL` so you can point it at OpenRouter, OpenAI, local Ollama, or any OpenAI-compatible endpoint.

6. **Dev proxy** — Vite proxies `/api/*` to the backend, avoiding CORS issues in development.

## API Endpoints

| Method | Path                     | Auth     | Description                    |
| ------ | ------------------------ | -------- | ------------------------------ |
| GET    | /api/health              | None     | Health check                   |
| POST   | /api/chat                | None     | Streaming chat (AI SDK)        |
| GET    | /api/documents           | None     | List indexed documents         |
| POST   | /api/documents/upload    | None     | Upload a local file (multipart) |
| POST   | /api/documents/import    | Bearer   | Import files from SharePoint   |
| DELETE | /api/documents/:id       | None     | Delete a document              |
| GET    | /api/sharepoint/sites    | Bearer   | List SharePoint sites          |
| GET    | /api/sharepoint/drives   | Bearer   | List drives for a site         |
| GET    | /api/sharepoint/files    | Bearer   | List files in a drive          |
| GET    | /api/auth/config         | None     | MSAL client configuration      |
| POST   | /api/auth/token          | None     | Token exchange (OBO flow)      |
