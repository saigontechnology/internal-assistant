import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Trash2,
  FileText,
  Clock,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
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

export function DocumentList({
  documents,
  isLoading,
  onDelete,
}: DocumentListProps) {
  if (isLoading) {
    return (
      <div className="dark flex flex-col gap-2 text-sidebar-foreground">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="dark py-6 text-center text-sm text-muted-foreground">
        No documents indexed yet.
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="dark flex flex-col gap-1.5 text-foreground">
        {documents.map((doc) => {
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
                  <AlertCircle className="size-4" />
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
                    <ExternalLink />
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
                  <Trash2 />
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
