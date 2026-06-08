import { tool, readUIMessageStream, type UIMessage } from "ai";
import { z } from "zod";
import { streamResearch } from "../agents/research-agent.js";

export {
  listDocumentsTool,
  retrieveResourcesTool,
} from "./document-tools.js";

export const SYSTEM_PROMPT = `You are Alice, the Internal Assistant. You answer questions about the user's uploaded documents.

Workflow — follow these steps in order:
1. Call listDocuments to see what files are available.
2. Call research(question) with a self-contained version of the user's question, mentioning relevant filenames if the user named any.
3. Read the research result and answer the user, citing filenames inline (e.g. "according to report.pdf"). Never use numeric indices like "Document 1".
4. If research returns no useful information, say so plainly.

Do not call any retrieval tool yourself — the research subagent handles that.`;

export const researchTool = tool({
  description:
    "Delegate the user's question to a research subagent. The subagent searches the document library and returns a citation-rich findings summary.",
  inputSchema: z.object({
    question: z
      .string()
      .describe(
        "A self-contained question to research — the subagent will not see chat history."
      ),
  }),
  execute: async function* ({ question }, { abortSignal }) {
    const result = streamResearch(question, abortSignal);
    for await (const message of readUIMessageStream({
      stream: result.toUIMessageStream(),
    })) {
      yield message;
    }
  },
  toModelOutput: ({ output }) => {
    const message = output as UIMessage | undefined;
    const finalText = message?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      ?.map((p) => p.text)
      ?.join("");
    return { type: "text", value: finalText || "Research completed." };
  },
});
