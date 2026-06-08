CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"content" text NOT NULL,
	"embedding" halfvec(2048) NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"file_type" text NOT NULL,
	"source" text NOT NULL,
	"sharepoint_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "embeddings_resource_id_idx" ON "embeddings" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "embeddings_hnsw_idx" ON "embeddings" USING hnsw ("embedding" halfvec_cosine_ops);