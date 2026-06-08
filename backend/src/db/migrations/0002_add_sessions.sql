CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"home_account_id" text NOT NULL,
	"token_cache" text NOT NULL,
	"username" text,
	"name" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
