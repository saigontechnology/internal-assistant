import { Hono } from "hono";
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { config } from "../config.js";
import {
  SYSTEM_PROMPT,
  listDocumentsTool,
  researchTool,
} from "../services/chat-service.js";

export const chatRoute = new Hono();

const openai = createOpenAI({
  baseURL: config.openaiApiBase,
  apiKey: config.openaiApiKey,
});

chatRoute.post("/chat", async (c) => {
  const { messages } = await c.req.json<{ messages: UIMessage[] }>();

  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model: openai.chat(config.chatModel),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    tools: {
      listDocuments: listDocumentsTool,
      research: researchTool,
    },
    stopWhen: stepCountIs(4),
  });

  return result.toUIMessageStreamResponse();
});
