import {
  createGoogleGenerativeAI,
  type GoogleGenerativeAIProvider,
} from '@ai-sdk/google'
import { AppConfig } from './app-config.service.js'

/**
 * Builds the AI SDK Google (Gemini) client used by the chat/generation
 * path when CHAT_PROVIDER=gemini. The embedding pipeline stays on
 * OpenAI — see docs/gemini-migration-plan.md.
 */
export function buildGoogleClient(config: AppConfig): GoogleGenerativeAIProvider {
  const apiKey = config.googleApiKey
  if (!apiKey) {
    throw new Error(
      'buildGoogleClient called but GOOGLE_GENERATIVE_AI_API_KEY is not set. ' +
        'Set the env var or switch CHAT_PROVIDER back to "openai".',
    )
  }
  return createGoogleGenerativeAI({ apiKey })
}
