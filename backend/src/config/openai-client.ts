import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai'
import { AppConfig } from './app-config.service.js'

/**
 * Single place that builds the AI SDK OpenAI client. All call sites
 * (chat, embeddings, documents) now go through here so the
 * Host-header override stays consistent — see env.schema.ts comment on
 * OPENAI_HOST_OVERRIDE for why.
 */
export function buildOpenAIClient(config: AppConfig): OpenAIProvider {
  return createOpenAI({
    baseURL: config.openaiApiBase,
    apiKey: config.openaiApiKey,
    headers: config.openaiHostOverride
      ? { host: config.openaiHostOverride }
      : undefined,
  })
}
