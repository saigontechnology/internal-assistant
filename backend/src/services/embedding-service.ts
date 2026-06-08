import { embed, embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { eq, sql, desc, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { resources, embeddings } from "../db/schema.js";
import type { TextChunk, DocumentInfo } from "../types.js";

const openai = createOpenAI({
  baseURL: config.openaiApiBase,
  apiKey: config.openaiApiKey,
});

export interface DocumentDescriptor {
  id: string;
  filename: string;
  fileType: string;
  source: "upload" | "sharepoint";
  sharepointUrl?: string;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: openai.textEmbeddingModel(config.embeddingModel),
    value: text,
  });
  return embedding;
}

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const { embeddings: vectors } = await embedMany({
    model: openai.textEmbeddingModel(config.embeddingModel),
    values: texts,
  });
  return vectors;
}

export async function addDocuments(
  doc: DocumentDescriptor,
  chunks: TextChunk[]
): Promise<number> {
  const vectors = await generateEmbeddings(chunks.map((c) => c.text));

  await db.insert(resources).values({
    id: doc.id,
    filename: doc.filename,
    fileType: doc.fileType,
    source: doc.source,
    sharepointUrl: doc.sharepointUrl,
  });

  await db.insert(embeddings).values(
    chunks.map((chunk, i) => ({
      id: nanoid(),
      resourceId: doc.id,
      content: chunk.text,
      embedding: vectors[i],
      metadata: chunk.metadata,
    }))
  );

  return chunks.length;
}

export async function deleteDocuments(docId: string): Promise<void> {
  await db.delete(resources).where(eq(resources.id, docId));
}

export interface SimilaritySearchOptions {
  k?: number;
  filenames?: string[];
  maxPerDoc?: number;
}

export async function similaritySearch(
  query: string,
  opts: SimilaritySearchOptions = {}
): Promise<{ content: string; metadata: Record<string, unknown> }[]> {
  const { k = 8, filenames, maxPerDoc = 3 } = opts;
  try {
    const queryEmbedding = await generateEmbedding(query);
    const distance = sql<number>`${embeddings.embedding} <=> ${JSON.stringify(queryEmbedding)}::halfvec`;

    const baseQuery = db
      .select({
        content: embeddings.content,
        metadata: embeddings.metadata,
        filename: resources.filename,
        distance,
      })
      .from(embeddings)
      .innerJoin(resources, eq(embeddings.resourceId, resources.id))
      .orderBy(distance)
      .limit(k * 3);

    const rows = filenames && filenames.length > 0
      ? await baseQuery.where(inArray(resources.filename, filenames))
      : await baseQuery;

    const perDoc = new Map<string, number>();
    const picked: typeof rows = [];
    for (const r of rows) {
      const n = perDoc.get(r.filename) ?? 0;
      if (n >= maxPerDoc) continue;
      perDoc.set(r.filename, n + 1);
      picked.push(r);
      if (picked.length >= k) break;
    }

    return picked.map((r) => ({
      content: r.content,
      metadata: {
        ...((r.metadata as Record<string, unknown>) ?? {}),
        filename: r.filename,
      },
    }));
  } catch (err) {
    console.warn("Similarity search failed:", (err as Error).message);
    return [];
  }
}

export async function listResourcesWithCounts(): Promise<DocumentInfo[]> {
  const rows = await db
    .select({
      id: resources.id,
      filename: resources.filename,
      fileType: resources.fileType,
      source: resources.source,
      sharepointUrl: resources.sharepointUrl,
      chunkCount: sql<number>`count(${embeddings.id})::int`,
      createdAt: resources.createdAt,
    })
    .from(resources)
    .leftJoin(embeddings, eq(embeddings.resourceId, resources.id))
    .groupBy(resources.id)
    .orderBy(desc(resources.createdAt));

  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    fileType: r.fileType,
    chunkCount: r.chunkCount,
    source: r.source as "upload" | "sharepoint",
    sharepointUrl: r.sharepointUrl ?? undefined,
  }));
}
