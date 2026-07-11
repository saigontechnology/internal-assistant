import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Trash,
  FileText,
  Clock,
  WarningCircle,
  ArrowSquareOut,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DocumentInfo, SyncStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

interface DocumentListProps {
  documents: DocumentInfo[];
  isLoading: boolean;
  onDelete: (docId: string) => void;
}

const STATUS_LABEL: Record<SyncStatus, string> = {
  synced: "Synced",
  pending_access: "Pending access",
  failed_parse: "Parse failed",
  failed_resolve: "Not found",
};

type FilterKey = "all" | "synced" | "pending" | "failed";

// Display order when no filter is active. The numeric weight is also the
// secondary sort key for the "All" view so users see the most useful rows
// (searchable ones) first.
const STATUS_WEIGHT: Record<SyncStatus, number> = {
  synced: 0,
  pending_access: 1,
  failed_parse: 2,
  failed_resolve: 2,
};

function classify(status: SyncStatus): Exclude<FilterKey, "all"> {
  if (status === "synced") return "synced";
  if (status === "pending_access") return "pending";
  return "failed";
}

export function DocumentList({
  documents,
  isLoading,
  onDelete,
}: DocumentListProps) {
  const [filter, setFilter] = useState<FilterKey>("all");

  // One pass over the input: build per-bucket counts, then derive the
  // filtered/sorted view. useMemo keeps it cheap for 375+ rows.
  const { counts, visible } = useMemo(() => {
    const counts = { all: documents.length, synced: 0, pending: 0, failed: 0 };
    for (const d of documents) {
      counts[classify(d.syncStatus ?? "synced")]++;
    }
    // eslint-disable-next-line no-useless-assignment
    let visible = documents;
    if (filter === "all") {
      // Stable sort by status weight (synced → pending → failed) so the
      // most useful rows surface first.
      visible = [...documents].sort(
        (a, b) =>
          STATUS_WEIGHT[a.syncStatus ?? "synced"] -
          STATUS_WEIGHT[b.syncStatus ?? "synced"],
      );
    } else {
      visible = documents.filter(
        (d) => classify(d.syncStatus ?? "synced") === filter,
      );
    }
    return { counts, visible };
  }, [documents, filter]);

  // Filter bar — always rendered, sits OUTSIDE the scroll region. `shrink-0`
  // keeps it from squishing as the list grows.
  const filterBar = (
    <div className="shrink-0 border-b border-border px-4 py-2.5">
      <div className="flex flex-wrap gap-1">
        <FilterButton
          label="All"
          count={counts.all}
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        <FilterButton
          label="Synced"
          count={counts.synced}
          tone="ok"
          active={filter === "synced"}
          onClick={() => setFilter("synced")}
        />
        <FilterButton
          label="Pending"
          count={counts.pending}
          tone="muted"
          active={filter === "pending"}
          onClick={() => setFilter("pending")}
        />
        <FilterButton
          label="Failed"
          count={counts.failed}
          tone="error"
          active={filter === "failed"}
          onClick={() => setFilter("failed")}
        />
      </div>
    </div>
  );

  // Loading / empty / list states share the same two-section layout: filter
  // bar on top (shrink-0), scrollable body below (flex-1 overflow-y-auto).
  // The two never overlap.
  if (isLoading) {
    return (
      <div className="dark flex min-h-0 flex-1 flex-col text-sidebar-foreground">
        {filterBar}
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="dark flex min-h-0 flex-1 flex-col text-sidebar-foreground">
        {filterBar}
        <div className="flex-1 overflow-y-auto py-6 text-center text-sm text-muted-foreground">
          No documents indexed yet.
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="dark flex min-h-0 flex-1 flex-col text-foreground">
        {filterBar}
        <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-4">
        {visible.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No {filter} documents.
          </p>
        )}
        {visible.map((doc) => {
          const isSpListRow = doc.source === "sharepoint-list";
          const status = doc.syncStatus ?? "synced";
          const isSearchable = status === "synced";
          // Title takes the top line. For SP-list rows that's `doc.title`
          // (the list's `Title` column); for legacy uploads we fall back to
          // the raw filename. The Code (e.g. "QC-SDC.01") moves to a
          // muted subtitle below.
          const primary = doc.title?.trim() || doc.filename;
          const subtitle = doc.sharepointCode || null;
          // Tooltip on the title still shows the full identity so long names
          // and the code stay reachable when truncated.
          const tooltipText = subtitle ? `${subtitle} — ${primary}` : primary;

          return (
            <div
              key={doc.id}
              className={cn(
                "group flex items-center gap-2.5 rounded-lg border p-2.5 text-sm transition-colors",
                isSearchable
                  ? "border-border bg-card hover:border-primary/30 hover:bg-accent/40"
                  : "border-border/60 bg-card/40 opacity-80",
              )}
            >
              <div
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-lg",
                  isSearchable
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {status === "pending_access" ? (
                  <Clock className="size-4" />
                ) : status === "failed_parse" || status === "failed_resolve" ? (
                  <WarningCircle className="size-4" />
                ) : (
                  <FileText className="size-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* `truncate` clips long titles with ellipsis; the
                        tooltip shows the full code + title on hover.
                        tabIndex makes it keyboard-accessible too. */}
                    <p
                      tabIndex={0}
                      className="truncate font-medium outline-none"
                    >
                      {primary}
                    </p>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-md break-words">
                    {tooltipText}
                  </TooltipContent>
                </Tooltip>
                {subtitle && (
                  <p className="truncate font-mono text-[11px] tabular-nums text-muted-foreground">
                    {subtitle}
                  </p>
                )}
                <div className="mt-0.5 flex items-center gap-1.5">
                  {doc.sharepointVersion && (
                    <Badge variant="secondary" className="text-xs">
                      v{doc.sharepointVersion}
                    </Badge>
                  )}
                  {doc.sharepointPendingVersion &&
                    doc.sharepointPendingVersion !== doc.sharepointVersion && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className="cursor-help gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs"
                          >
                            <ArrowsClockwise className="size-3" />
                            v{doc.sharepointPendingVersion} pending
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs">
                          A newer version (v{doc.sharepointPendingVersion}) is
                          listed in SharePoint, but no signed-in user has been
                          able to fetch it yet. Search results still use
                          v{doc.sharepointVersion}. Ask someone with access to
                          this file to run a sync.
                        </TooltipContent>
                      </Tooltip>
                    )}
                  {!isSpListRow && (
                    <Badge variant="secondary" className="text-xs">
                      {doc.fileType.toUpperCase()}
                    </Badge>
                  )}
                  {isSearchable ? (
                    <span className="text-xs text-muted-foreground">
                      {doc.chunkCount} chunks
                    </span>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={cn(
                            "cursor-help text-xs",
                            status === "pending_access"
                              ? "text-muted-foreground"
                              : "text-destructive",
                          )}
                        >
                          {STATUS_LABEL[status]}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-xs">
                        {status === "pending_access"
                          ? "The signed-in user doesn't have access to this file's source library. It will sync automatically once IT grants tenant-wide Application permissions."
                          : (doc.syncError ?? STATUS_LABEL[status])}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
              {doc.linkUrl && (
                <Button
                  asChild
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  {/* noopener+noreferrer because the target URL is on a
                          different SharePoint origin we don't fully control. */}
                  <a
                    href={doc.linkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Open ${tooltipText} in a new tab`}
                  >
                    <ArrowSquareOut />
                  </a>
                </Button>
              )}
              {!isSpListRow && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onDelete(doc.id)}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash />
                </Button>
              )}
            </div>
          );
        })}
        </div>
      </div>
    </TooltipProvider>
  );
}

function FilterButton({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  tone?: "ok" | "muted" | "error";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border bg-card/40 text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded px-1 font-mono text-[10px] tabular-nums",
          active
            ? "bg-primary/15 text-foreground"
            : tone === "ok"
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : tone === "error"
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
}
