import { useState } from "react"
import { Markdown } from "./markdown"
import {
  WarningCircle,
  CaretDown,
  CaretRight,
  ArrowElbowDownRight,
  Books,
  MagnifyingGlass,
  Binoculars,
  type Icon,
} from "@phosphor-icons/react"
import { cn } from "@/lib/utils"

type NestedPart = {
  type: string
  text?: string
  input?: { query?: string; filenames?: string[]; question?: string }
  state?: string
}

type NestedMessage = {
  parts?: NestedPart[]
}

type ToolPart = {
  type: string
  toolCallId: string
  state:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error"
    | string
  input?: { query?: string; filenames?: string[]; question?: string }
  output?: unknown
  errorText?: string
  preliminary?: boolean
}

interface ToolCallProps {
  part: ToolPart
}

interface ToolView {
  icon: Icon
  runningLabel: string
  doneLabel: string
  detail?: string
  errorLabel: string
  /** Render expanded output as markdown, raw text, or nested subagent UIMessage. */
  outputFormat: "markdown" | "raw" | "subagent"
}

function getView(part: ToolPart): ToolView {
  const toolName = part.type.replace(/^tool-/, "")
  const query = part.input?.query
  const filenames = part.input?.filenames

  if (toolName === "listDocuments") {
    return {
      icon: Books,
      runningLabel: "Listing documents…",
      doneLabel: "Listed documents",
      errorLabel: "List failed",
      outputFormat: "raw",
    }
  }

  if (toolName === "research") {
    const question = part.input?.question
    return {
      icon: Binoculars,
      runningLabel: question
        ? `Researching "${question}"…`
        : "Researching…",
      doneLabel: "Researched",
      detail: question ? `"${question}"` : undefined,
      errorLabel: "Research failed",
      outputFormat: "subagent",
    }
  }

  // default: retrieveResources (and any future search-shaped tool)
  const scope =
    filenames && filenames.length > 0
      ? ` in ${filenames.join(", ")}`
      : ""
  return {
    icon: MagnifyingGlass,
    runningLabel: query
      ? `Searching for "${query}"${scope}…`
      : "Searching documents…",
    doneLabel: "Searched documents",
    detail: query ? `for "${query}"${scope}` : undefined,
    errorLabel: "Search failed",
    outputFormat: "raw",
  }
}

function SubStepLine({ part }: { part: NestedPart }) {
  const toolName = part.type.replace(/^tool-/, "")
  let icon: Icon = MagnifyingGlass
  let label = toolName
  if (toolName === "listDocuments") {
    icon = Books
    label = "Listing documents"
  } else if (toolName === "retrieveResources") {
    icon = MagnifyingGlass
    const q = part.input?.query
    const scope = part.input?.filenames?.length
      ? ` in ${part.input.filenames.join(", ")}`
      : ""
    label = q ? `Searching for "${q}"${scope}` : "Searching documents"
  }
  const Icon = icon
  return (
    <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
      <ArrowElbowDownRight className="mt-0.5 size-3 shrink-0" />
      <Icon className="mt-0.5 size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  )
}

function SubagentBody({ message }: { message: NestedMessage }) {
  const parts = message.parts ?? []
  const subSteps = parts.filter(
    (p) =>
      p.type.startsWith("tool-") &&
      p.type.replace(/^tool-/, "") !== "listDocuments",
  )
  const finalText = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
  return (
    <div className="flex flex-col gap-2 border-t border-border bg-muted/40 px-4 py-3">
      {subSteps.length > 0 && (
        <div className="flex flex-col gap-1">
          {subSteps.map((sub, i) => (
            <SubStepLine key={i} part={sub} />
          ))}
        </div>
      )}
      {finalText && (
        <div className="prose-message max-h-[28rem] overflow-auto text-xs">
          <Markdown>{finalText}</Markdown>
        </div>
      )}
    </div>
  )
}

export function ToolCall({ part }: ToolCallProps) {
  const [manuallyCollapsed, setManuallyCollapsed] = useState<boolean | null>(
    null
  )
  // listDocuments returns a noisy inventory the user shouldn't see surfaced
  // as a step. The agent uses it internally for routing; we skip the UI row.
  if (part.type.replace(/^tool-/, "") === "listDocuments") return null
  const view = getView(part)
  const Icon = view.icon
  const isError = part.state === "output-error"
  const isPreliminary = part.preliminary === true
  const isComplete = part.state === "output-available" && !isPreliminary
  const isStreaming =
    isPreliminary ||
    part.state === "input-streaming" ||
    part.state === "input-available"

  if (isError) {
    return (
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        <WarningCircle className="size-3.5 shrink-0" />
        <span className="truncate">
          {view.errorLabel}
          {part.errorText ? `: ${part.errorText}` : ""}
        </span>
      </div>
    )
  }

  // Auto-expand while streaming subagent progress; collapse on complete unless user opened.
  const defaultExpanded = view.outputFormat === "subagent" && isStreaming
  const expanded =
    manuallyCollapsed === null ? defaultExpanded : !manuallyCollapsed

  const hasBody =
    view.outputFormat === "subagent"
      ? Boolean(part.output && (part.output as NestedMessage).parts?.length)
      : isComplete && typeof part.output === "string"

  return (
    <div className="mb-2 rounded-lg border border-border bg-background/60">
      <button
        type="button"
        onClick={() => hasBody && setManuallyCollapsed(expanded)}
        disabled={!hasBody}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-xs",
          hasBody && "cursor-pointer hover:bg-accent/40"
        )}
      >
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            isStreaming ? "text-primary" : "text-muted-foreground"
          )}
        />
        {isStreaming ? (
          <span className="thinking-text font-medium">{view.runningLabel}</span>
        ) : (
          <>
            <span className="font-medium text-foreground">{view.doneLabel}</span>
            {view.detail && (
              <span className="truncate text-muted-foreground">
                {view.detail}
              </span>
            )}
          </>
        )}
        {hasBody && (
          <span className="ml-auto shrink-0 text-muted-foreground">
            {expanded ? (
              <CaretDown className="size-3.5" />
            ) : (
              <CaretRight className="size-3.5" />
            )}
          </span>
        )}
      </button>
      {hasBody && expanded && (
        view.outputFormat === "subagent" ? (
          <SubagentBody message={part.output as NestedMessage} />
        ) : view.outputFormat === "markdown" ? (
          <div className="prose-message max-h-[28rem] overflow-auto border-t border-border bg-muted/40 px-4 py-3 text-xs">
            <Markdown>{part.output as string}</Markdown>
          </div>
        ) : (
          <pre className="max-h-72 overflow-auto border-t border-border bg-muted/40 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
            {part.output as string}
          </pre>
        )
      )}
    </div>
  )
}
