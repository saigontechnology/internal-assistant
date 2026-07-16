import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai'
import { AppConfig } from './app-config.service.js'

/**
 * Single place that builds the AI SDK OpenAI client. All call sites
 * (chat, embeddings, documents) go through here.
 */
export function buildOpenAIClient(config: AppConfig): OpenAIProvider {
  return createOpenAI({
    baseURL: config.openaiApiBase,
    apiKey: config.openaiApiKey,
  })
}
