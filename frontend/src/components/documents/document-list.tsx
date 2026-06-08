import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Trash2, FileText } from "lucide-react"
import type { DocumentInfo } from "@/lib/api"

interface DocumentListProps {
  documents: DocumentInfo[]
  isLoading: boolean
  onDelete: (docId: string) => void
}

export function DocumentList({
  documents,
  isLoading,
  onDelete,
}: DocumentListProps) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  if (documents.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        No documents imported yet.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {documents.map((doc) => (
        <div
          key={doc.id}
          className="group flex items-center gap-2.5 rounded-lg border border-border bg-card p-2.5 text-sm transition-colors hover:border-primary/30 hover:bg-accent/40"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileText className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{doc.filename}</p>
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary" className="text-xs">
                {doc.fileType.toUpperCase()}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {doc.chunkCount} chunks
              </span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onDelete(doc.id)}
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  )
}
