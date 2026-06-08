import { z } from "zod";

const envSchema = z.object({
  OPENAI_API_BASE: z.string().default("https://openrouter.ai/api/v1"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  CHAT_MODEL: z.string().default("deepseek/deepseek-v4-flash:free"),
  EMBEDDING_MODEL: z.string().default("nvidia/llama-nemotron-embed-vl-1b-v2:free"),
  CHUNK_SIZE: z.coerce.number().default(1000),
  CHUNK_OVERLAP: z.coerce.number().default(200),

  DATABASE_URL: z.string().url("DATABASE_URL must be a valid Neon connection string"),

  AZURE_CLIENT_ID: z.string().min(1, "AZURE_CLIENT_ID is required"),
  AZURE_TENANT_ID: z.string().min(1, "AZURE_TENANT_ID is required"),
  AZURE_CLIENT_SECRET: z.string().min(1, "AZURE_CLIENT_SECRET is required"),
  AZURE_REDIRECT_URI: z.string().default("http://localhost:5173/api/auth/callback"),

  FRONTEND_URL: z.string().default("http://localhost:5173"),
  SESSION_SECRET: z.string().min(1).default("dev-insecure-secret-change-me"),
  NODE_ENV: z.enum(["development", "production"]).default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  openaiApiBase: env.OPENAI_API_BASE,
  openaiApiKey: env.OPENAI_API_KEY,
  chatModel: env.CHAT_MODEL,
  embeddingModel: env.EMBEDDING_MODEL,
  chunkSize: env.CHUNK_SIZE,
  chunkOverlap: env.CHUNK_OVERLAP,

  databaseUrl: env.DATABASE_URL,

  azureClientId: env.AZURE_CLIENT_ID,
  azureTenantId: env.AZURE_TENANT_ID,
  azureClientSecret: env.AZURE_CLIENT_SECRET,
  azureRedirectUri: env.AZURE_REDIRECT_URI,

  frontendUrl: env.FRONTEND_URL,
  sessionSecret: env.SESSION_SECRET,
  isProd: env.NODE_ENV === "production",
} as const;

// Microsoft Graph delegated scopes requested during sign-in. MSAL adds the
// reserved openid/profile/offline_access scopes automatically.
export const graphScopes = ["Sites.Read.All", "Files.Read.All"];
