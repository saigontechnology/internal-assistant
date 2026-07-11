import { useState, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Cloud, FolderOpen, CircleNotch, SignIn, UploadSimple } from "@phosphor-icons/react"
import { uploadFile } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { useAppView } from "@/lib/app-view"
import { Separator } from "@/components/ui/separator"

interface UploadZoneProps {
  onUploadComplete: () => void
}

const ACCEPTED_EXTENSIONS = ".pdf,.txt,.md,.docx,.csv,.xlsx"

export function UploadZone({ onUploadComplete }: UploadZoneProps) {
  const { isAuthenticated, login } = useAuth()
  const { setView } = useAppView()
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFile = e.target.files?.[0]
      if (!selectedFile) return
      e.target.value = ""
      setError(null)
      setIsUploading(true)
      try {
        await uploadFile(selectedFile)
        onUploadComplete()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed")
      } finally {
        setIsUploading(false)
      }
    },
    [onUploadComplete]
  )

  const localUploadSection = (
    <div className="flex flex-col gap-3">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS}
        onChange={handleFileUpload}
        className="hidden"
      />
      <div
        onClick={() => fileInputRef.current?.click()}
        className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 p-6 text-center transition-colors hover:border-primary/50 hover:bg-accent/30"
      >
        <UploadSimple className="size-8 text-muted-foreground" />
        <div className="text-sm text-muted-foreground">
          <p>Upload a file</p>
          <p className="text-xs">PDF, TXT, DOCX, MD, CSV, XLSX</p>
        </div>
      </div>
      {isUploading && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <CircleNotch className="size-4 animate-spin" />
          Uploading & indexing...
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col gap-3">
        {localUploadSection}
        <Separator />
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 p-6 text-center">
          <Cloud className="size-8 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            <p>Connect to SharePoint</p>
            <p className="text-xs">Sign in with your Microsoft account to import documents</p>
          </div>
        </div>
        <Button variant="outline" className="w-full" onClick={login}>
          <SignIn data-icon="inline-start" />
          Sign in with Microsoft
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {localUploadSection}
      <Separator />
      <Button
        variant="outline"
        className="w-full"
        onClick={() => setView("sharepoint")}
      >
        <FolderOpen data-icon="inline-start" />
        Browse SharePoint
      </Button>
    </div>
  )
}
