import {
  streamText,
  stepCountIs,
  type StreamTextResult,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { config } from "../config.js";
import {
  listDocumentsTool,
  retrieveResourcesTool,
} from "../services/document-tools.js";

const openai = createOpenAI({
  baseURL: config.openaiApiBase,
  apiKey: config.openaiApiKey,
});

const INSTRUCTIONS = `You are a research subagent for Alice, the Internal Assistant. Investigate the given question against the user's document library.

Approach:
- Start with listDocuments if you don't already know what files are available.
- Call retrieveResources multiple times with different query angles (synonyms, sub-questions, related concepts). Use the filenames argument to drill into specific files when relevant.
- Don't stop after a single search — aim for 2-3 retrievals covering different angles before synthesizing.
- If a retrieval returns nothing useful, refine the query and try again.

Output format:
- A concise findings summary (a few short paragraphs OR a bulleted list).
- Every claim cites a filename inline, e.g. "(from report.pdf)".
- If the corpus genuinely doesn't contain an answer, say so plainly.

Do not address the user directly — your output is consumed by another agent that will present the final answer.`;

const tools = {
  listDocuments: listDocumentsTool,
  retrieveResources: retrieveResourcesTool,
};

export function streamResearch(
  question: string,
  abortSignal?: AbortSignal
): StreamTextResult<typeof tools, never> {
  return streamText({
    model: openai.chat(config.chatModel),
    system: INSTRUCTIONS,
    prompt: question,
    tools,
    stopWhen: stepCountIs(6),
    abortSignal,
  });
}
