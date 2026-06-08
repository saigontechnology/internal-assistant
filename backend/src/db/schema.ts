import { pgTable, text, timestamp, jsonb, halfvec, index } from "drizzle-orm/pg-core";

export const EMBEDDING_DIM = 2048;

export const resources = pgTable("resources", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  fileType: text("file_type").notNull(),
  source: text("source").notNull(),
  sharepointUrl: text("sharepoint_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const embeddings = pgTable(
  "embeddings",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    embedding: halfvec("embedding", { dimensions: EMBEDDING_DIM }).notNull(),
    metadata: jsonb("metadata"),
  },
  (t) => [
    index("embeddings_resource_id_idx").on(t.resourceId),
    index("embeddings_hnsw_idx").using("hnsw", t.embedding.op("halfvec_cosine_ops")),
  ]
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  homeAccountId: text("home_account_id").notNull(),
  tokenCache: text("token_cache").notNull(),
  username: text("username"),
  name: text("name"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Resource = typeof resources.$inferSelect;
export type NewResource = typeof resources.$inferInsert;
export type Embedding = typeof embeddings.$inferSelect;
export type NewEmbedding = typeof embeddings.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
