# API Reference

All endpoints are prefixed with `/api`. In development, the Vite dev server proxies these to `http://localhost:8000`.

## Health

### `GET /api/health`

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "service": "internal-assistant"
}
```

---

## Documents

### `POST /api/documents/upload`

Upload and index a local file. The file is parsed in-memory, chunked, embedded, and stored in Postgres (`resources` + `embeddings`).

**Request:** `multipart/form-data`

| Field  | Type   | Description                             |
| ------ | ------ | --------------------------------------- |
| `file` | `File` | The document to upload (required)       |

**Supported file types:** `.pdf`, `.txt`, `.md`, `.docx`, `.csv`, `.xlsx`

**Response:** `200 OK`

```json
{
  "id": "a1b2c3d4e5f6",
  "filename": "report.pdf",
  "chunkCount": 42,
  "source": "upload"
}
```

**Errors:**

| Code  | Condition                              |
| ----- | -------------------------------------- |
| `400` | No file provided or unsupported type   |

---

### `POST /api/documents/import`

Import one or more files from SharePoint. Requires a Microsoft Graph bearer token in the `Authorization` header. Each file is fetched via Graph, parsed, chunked, embedded, and stored in Postgres.

**Request:** `application/json`

```json
{
  "files": [
    { "driveId": "b!abc...", "itemId": "01XYZ...", "name": "report.pdf" }
  ]
}
```

**Response:** `200 OK` (or `207` if any imports failed)

```json
{
  "imported": [
    { "id": "a1b2c3d4e5f6", "filename": "report.pdf", "chunkCount": 42, "source": "sharepoint" }
  ],
  "errors": []
}
```

**Errors:**

| Code  | Condition                                  |
| ----- | ------------------------------------------ |
| `400` | No files specified                         |
| `401` | Missing or invalid `Authorization` header  |
| `207` | Partial success — see `errors` array       |

---

### `GET /api/documents`

List all indexed documents with their chunk counts.

**Response:** `200 OK`

```json
{
  "documents": [
    {
      "id": "a1b2c3d4e5f6",
      "filename": "report.pdf",
      "fileType": "pdf",
      "chunkCount": 42,
      "source": "sharepoint",
      "sharepointUrl": "https://contoso.sharepoint.com/..."
    }
  ]
}
```

---

### `DELETE /api/documents/{doc_id}`

Delete a document from the `resources` table. The associated rows in `embeddings` are removed automatically via `ON DELETE CASCADE`.

**Path parameters:**

| Param    | Type     | Description         |
| -------- | -------- | ------------------- |
| `doc_id` | `string` | The document ID     |

**Response:** `200 OK`

```json
{
  "message": "Document deleted successfully",
  "id": "a1b2c3d4e5f6"
}
```

**Errors:**

| Code  | Condition          |
| ----- | ------------------ |
| `404` | Document not found |

---

## Chat

### `POST /api/chat`

Streaming RAG chat. Retrieves relevant document chunks, builds a context-augmented prompt, and streams the LLM response.

**Request:** `application/json`

```json
{
  "messages": [
    { "role": "user", "content": "What does the report say about revenue?" },
    { "role": "assistant", "content": "According to the report..." },
    { "role": "user", "content": "Can you give more details?" }
  ]
}
```

**Response:** `text/event-stream` (Vercel AI Data Stream v2)

The response streams newline-delimited JSON events:

```
{"type": "start"}
{"type": "start-step"}
{"type": "text-start", "id": "abc123"}
{"type": "text-delta", "delta": "According", "id": "abc123"}
{"type": "text-delta", "delta": " to the", "id": "abc123"}
{"type": "text-delta", "delta": " report...", "id": "abc123"}
{"type": "text-end", "id": "abc123"}
{"type": "finish-step"}
{"type": "finish", "finishReason": "stop"}
```

**Headers:**

| Header                     | Value |
| -------------------------- | ----- |
| `x-vercel-ai-data-stream`  | `v2`  |

This format is consumed directly by the Vercel AI SDK `useChat()` hook on the frontend.

---

## Data Models

### ChatMessage

| Field     | Type     | Description              |
| --------- | -------- | ------------------------ |
| `role`    | `string` | `"user"` or `"assistant"` |
| `content` | `string` | Message text             |

### DocumentInfo

| Field           | Type     | Description                                       |
| --------------- | -------- | ------------------------------------------------- |
| `id`            | `string` | Document ID (nanoid)                              |
| `filename`      | `string` | Original filename                                 |
| `fileType`      | `string` | Extension without dot                             |
| `chunkCount`    | `int`    | Number of indexed chunks                          |
| `source`        | `string` | `"upload"` or `"sharepoint"`                      |
| `sharepointUrl` | `string` | Web URL of the SharePoint item (when applicable)  |
