# Workflows

## 1. Document Import & Indexing

Documents enter Internal Assistant through two paths — direct local upload or SharePoint import. Both converge on the same pipeline: parse, chunk, embed, persist to Postgres.

```
User picks files     Frontend             Backend                  Services
in browser     →     SharePointPicker  →  POST /api/documents/  →  pipeline
                     or UploadZone        import | upload
```

### Step-by-step

1. **Frontend** — `SharePointPicker` lets the user browse sites/drives via Graph and select files, then calls `POST /api/documents/import` with `{ files: [{ driveId, itemId, name }] }` and a bearer token. `UploadZone` posts local files to `POST /api/documents/upload` as `multipart/form-data`.

2. **Fetch / receive file** — For SharePoint imports, `sharepoint-service.ts` calls Microsoft Graph (`/drives/{driveId}/items/{itemId}/content`) to download the file. For local uploads, the buffer is taken straight from the multipart form.

3. **Parse** — `lib/parsers.ts` selects a parser by file extension:

   | Extension | Parser     |
   | --------- | ---------- |
   | `.pdf`    | pdf-parse  |
   | `.txt`    | utf-8      |
   | `.md`     | utf-8      |
   | `.docx`   | mammoth    |
   | `.csv`    | csv-parse  |
   | `.xlsx`   | xlsx       |

4. **Chunk** — `lib/text-splitter.ts` runs a recursive character splitter using `CHUNK_SIZE` (default 1000) and `CHUNK_OVERLAP` (default 200).

5. **Embed & persist** — `embedding-service.ts::addDocuments()`:
   - Calls `embedMany()` from the Vercel AI SDK against the configured embedding model.
   - Inserts one row into `resources` (id, filename, file type, source, optional SharePoint URL).
   - Bulk-inserts chunks into `embeddings`, each with its `halfvec(2048)` vector and JSON metadata.

6. **Response** — Returns `{ id, filename, chunkCount, source }`. The sidebar refreshes the document list.

```
                ┌──────────────────────┐
                │ SharePointPicker /   │
                │      UploadZone      │
                └──────────┬───────────┘
                           │ POST /api/documents/{import|upload}
                           ▼
                ┌──────────────────────┐
                │ document-service.ts  │
                │ fetch / receive file │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │     parsers.ts       │
                │   extract text       │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │  text-splitter.ts    │
                │  chunk by chars      │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │ embedding-service.ts │
                │  embedMany() →       │
                │  INSERT resources +  │
                │  INSERT embeddings   │
                │  (halfvec 2048)      │
                └──────────┬───────────┘
                           │
                           ▼
                ┌──────────────────────┐
                │      Response        │
                │ {id, chunkCount,...} │
                └──────────────────────┘
```

---

## 2. Chat (RAG Query)

When a user sends a message, the system retrieves the most relevant chunks from Postgres and uses them as context for the LLM.

### Step-by-step

1. **Frontend** — `ChatPanel` uses the Vercel AI SDK `useChat()` hook. On submit it sends `POST /api/chat` with `{ messages: [{role, content}, ...] }`.

2. **Extract query** — The last user message becomes the retrieval query.

3. **Retrieve** — `embedding-service.ts::similaritySearch(query, k=4)` embeds the query, then runs a single SQL query that joins `embeddings → resources` and orders by cosine distance:

   ```sql
   SELECT e.content, e.metadata, r.filename,
          e.embedding <=> $1::halfvec AS distance
   FROM embeddings e
   JOIN resources r ON r.id = e.resource_id
   ORDER BY distance
   LIMIT $k;
   ```

   The HNSW index (`halfvec_cosine_ops`) on `embeddings.embedding` makes this fast.

4. **Build context** — Retrieved chunks are formatted into a context block:
   ```
   [Document 1: report.pdf]
   ...chunk content...

   ---

   [Document 2: notes.md]
   ...chunk content...
   ```

5. **Construct prompt** — `chat-service.ts` builds the AI SDK message list:
   - A system message with the RAG prompt template + context
   - The full conversation history as user/assistant messages

6. **Stream** — Calls `streamText()` from the `ai` package against the configured chat model.

7. **Protocol** — The route returns the SDK's native UI message stream (`x-vercel-ai-data-stream: v2`), which `useChat()` consumes directly.

8. **Render** — `MessageList` auto-scrolls and `MessageBubble` renders user/assistant turns.

```
┌───────────┐     ┌───────────┐     ┌──────────────┐     ┌───────────┐
│   User    │────▶│ useChat() │────▶│ POST /api/   │────▶│ Extract   │
│   types   │     │ sendMsg() │     │    chat      │     │ last user │
│  question │     └───────────┘     └──────────────┘     │  message  │
└───────────┘                                             └─────┬─────┘
                                                                │
                                                                ▼
                                                         ┌──────────────┐
                                                         │ similarity   │
                                                         │ Search(k=4)  │
                                                         │ (pgvector    │
                                                         │  HNSW)       │
                                                         └──────┬───────┘
                                                                │
                                                                ▼
                                                         ┌──────────────┐
                                                         │ Build context│
                                                         │ + system     │
                                                         │   prompt     │
                                                         └──────┬───────┘
                                                                │
                                                                ▼
                                                         ┌──────────────┐
                                                         │ streamText() │
                                                         │  (AI SDK)    │
                                                         └──────┬───────┘
                                                                │
                              ┌──────────────────────────────────┘
                              ▼
                       ┌──────────────┐     ┌───────────┐
                       │  UI message  │────▶│ useChat() │
                       │   stream     │     │ renders   │
                       │ (AI SDK v2)  │     │  tokens   │
                       └──────────────┘     └───────────┘
```

---

## 3. Document Management

### List Documents

- **Trigger:** Sidebar mounts or an import completes
- **Flow:** `fetchDocuments()` → `GET /api/documents` → `listResourcesWithCounts()` runs a `LEFT JOIN` from `resources` to `embeddings` grouped by `resource_id`, ordered by `created_at DESC`
- **Display:** `DocumentList` renders cards with filename, file-type badge, source (upload/SharePoint), and chunk count

### Delete Document

- **Trigger:** User clicks the trash icon on a document card
- **Flow:** `handleDelete()` → `DELETE /api/documents/{doc_id}` → `DELETE FROM resources WHERE id = $1` → `ON DELETE CASCADE` removes the matching rows from `embeddings`
- **UI update:** The card is removed from local state immediately after the API call succeeds
