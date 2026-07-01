import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/layout/theme-toggle"
import {
  fetchUserPermission,
  fetchUserSyncStatus,
  startUserSync,
  type UserPermissionStatus,
  type UserSyncStatus,
} from "@/lib/api"
import logoUrl from "@/assets/logo.svg"

const POLL_INTERVAL_MS = 30_000

interface Props {
  /** Initial permission row (already fetched by App.tsx). */
  initial: UserPermissionStatus
  /** Called once the user's library is ready so the parent can unmount us. */
  onReady: () => void
}

/**
 * First-time setup gate. Replaces the chat UI while the per-user permission
 * sync is queued or running.
 *
 * Four sub-states (driven by GET /api/user/sync/status, polled every 30 s):
 *
 *   A. state="idle" AND firstSyncing      → welcome card with "Begin Setup"
 *   B. state="queued"                     → queue position + "waiting" copy
 *   C. state="running"                    → progress bar + percent
 *   D. state="done" / !firstSyncing       → call onReady() and unmount
 *
 * Page refresh during B/C lands back here because firstSyncing is still true
 * on the server.
 */
export function FirstTimeSetup({ initial, onReady }: Props) {
  const [permission, setPermission] = useState<UserPermissionStatus>(initial)
  const [status, setStatus] = useState<UserSyncStatus | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollTimer = useRef<number | null>(null)

  const poll = useCallback(async () => {
    try {
      const [perm, syncStatus] = await Promise.all([
        fetchUserPermission(),
        fetchUserSyncStatus(),
      ])
      setPermission(perm)
      setStatus(syncStatus)
      if (!perm.firstSyncing) {
        onReady()
      }
    } catch (err) {
      setError((err as Error).message ?? "Failed to load setup status")
    }
  }, [onReady])

  useEffect(() => {
    void poll()
    const id = window.setInterval(poll, POLL_INTERVAL_MS)
    pollTimer.current = id
    return () => {
      if (pollTimer.current !== null) {
        window.clearInterval(pollTimer.current)
        pollTimer.current = null
      }
    }
  }, [poll])

  const handleBegin = useCallback(async () => {
    setIsStarting(true)
    setError(null)
    try {
      await startUserSync()
      const perm = await fetchUserPermission()
      setPermission(perm)
      await poll()
    } catch (err) {
      setError((err as Error).message ?? "Failed to start setup")
    } finally {
      setIsStarting(false)
    }
  }, [poll])

  // ── Render branches ─────────────────────────────────────────────────

  if (!status) {
    return (
      <SetupShell>
        <SetupHeader
          title="Internal Assistant"
          subtitle="Loading your library status…"
        />
      </SetupShell>
    )
  }

  if (status.state === "idle" && permission.firstSyncing) {
    return (
      <SetupShell>
        <SetupHeader
          title="Welcome to Internal Assistant"
          subtitle="This is the first time you use Internal Assistant. We will set up resources for you before you can start using Internal Assistant."
        />
        {error ? <ErrorBanner message={error} /> : null}
        <Button
          type="button"
          onClick={handleBegin}
          disabled={isStarting}
          className="mt-6 w-full"
          size="lg"
        >
          {isStarting ? "Starting…" : "Begin Setup"}
        </Button>
      </SetupShell>
    )
  }

  if (status.state === "queued") {
    return (
      <SetupShell>
        <SetupHeader
          title="You're in the queue"
          subtitle="We can only set up one library at a time. We'll start yours as soon as the current user finishes."
        />
        <div className="mt-6 rounded-md border border-border bg-muted/40 px-4 py-3 text-center text-sm">
          <div className="font-medium text-foreground">
            Position {status.yourPosition ?? "?"} of {status.queueLength}
          </div>
          <div className="mt-1 text-muted-foreground">
            You can leave this tab open, refresh, or come back later.
          </div>
        </div>
        {error ? <ErrorBanner message={error} /> : null}
      </SetupShell>
    )
  }

  if (status.state === "running") {
    return (
      <SetupShell>
        <SetupHeader
          title="Setting up your library"
          subtitle="Indexing the documents you have access to."
        />
        <div className="mt-6">
          <ProgressBar percent={status.progressPercent} />
        </div>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          This process may take several minutes. Feel free to leave this tab —
          your setup will keep running in the background, and you can come back
          to check on it at any time.
        </p>
        {error ? <ErrorBanner message={error} /> : null}
      </SetupShell>
    )
  }

  // state === "done" — onReady() will swap us out shortly.
  return (
    <SetupShell>
      <SetupHeader title="Almost there…" subtitle="Finalizing your library." />
    </SetupShell>
  )
}

function SetupShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex h-16 items-center px-5">
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-sm">
          {children}
        </div>
      </main>
    </div>
  )
}

function SetupHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col items-center text-center">
      <img
        src={logoUrl}
        alt="Internal Assistant"
        className="h-8 w-auto shrink-0"
      />
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
    </div>
  )
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end text-sm">
        <span className="font-medium text-foreground">{percent}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      role="alert"
    >
      {message}
    </div>
  )
}
