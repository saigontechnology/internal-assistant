-- Baseline schema for the NestJS rewrite. Reproduces the drizzle-managed
-- state byte-for-byte against an empty database. Safe no-op when applied
-- via 'prisma migrate resolve --applied 0000_init' on a DB that already
-- went through the drizzle migrations.

-- Required by the halfvec(2048) column below. Idempotent.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "resources" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sharepoint_url" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embeddings" (
    "id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" halfvec(2048) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "home_account_id" TEXT NOT NULL,
    "token_cache" TEXT NOT NULL,
    "username" TEXT,
    "name" TEXT,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "embeddings_resource_id_idx" ON "embeddings"("resource_id");

-- AddForeignKey
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

