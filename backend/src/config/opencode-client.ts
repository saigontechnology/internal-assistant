import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai'
import { AppConfig } from './app-config.service.js'

/**
 * OpenCode gateway client (opencode.ai). Same @ai-sdk/openai surface as
 * buildOpenAIClient, pointed at the OpenCode OpenAI-compatible endpoint.
 * Used only for the chat/generation path — embeddings stay on the
 * OpenRouter-backed OpenAI client. See docs/opencode-migration-plan.md.
 */
export function buildOpencodeClient(config: AppConfig): OpenAIProvider {
  const apiKey = config.opencodeApiKey
  if (!apiKey) {
    throw new Error('CHAT_PROVIDER=opencode but OPENCODE_API_KEY is not set')
  }
  return createOpenAI({
    baseURL: config.opencodeApiBase,
    apiKey,
  })
}
