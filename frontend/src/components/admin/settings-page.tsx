import { useCallback, useEffect, useState } from "react"
import { Lock, ArrowCounterClockwise } from "@phosphor-icons/react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  fetchAdminSettings,
  resetAdminSettings,
  updateAdminSettings,
  type AdminSettings,
} from "@/lib/admin-api"
import { PageHeader } from "./admin-ui"

type Draft = Record<string, string>

function draftFrom(s: AdminSettings): Draft {
  return Object.fromEntries(s.settings.map((x) => [x.key, x.value]))
}

function formatDate(value: string | null): string {
  if (!value) return ""
  return new Date(value).toLocaleString()
}

export function AdminSettingsPage() {
  const [data, setData] = useState<AdminSettings | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await fetchAdminSettings()
      setData(next)
      setDraft(draftFrom(next))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Only send what actually changed — the endpoint takes a sparse map.
  const changed = data?.settings.filter((s) => draft[s.key] !== s.value) ?? []

  async function save() {
    if (!changed.length) return
    setSaving(true)
    try {
      const next = await updateAdminSettings(
        Object.fromEntries(changed.map((s) => [s.key, draft[s.key]])),
      )
      setData(next)
      setDraft(draftFrom(next))
      toast.success(`Saved ${changed.length} setting${changed.length === 1 ? "" : "s"}.`)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function resetAll() {
    setSaving(true)
    try {
      const next = await resetAdminSettings()
      setData(next)
      setDraft(draftFrom(next))
      toast.success("All settings reverted to their environment defaults.")
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const pinned = data?.settings.some((s) => s.source === "db") ?? false

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-9 w-48" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 w-full rounded-xl" />
        ))}
      </div>
    )
  }
  if (!data) return null

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        description="Runtime configuration. A setting you haven't touched falls back to its environment variable, so an untouched deployment behaves exactly as before. Changes apply within 30 seconds, without a restart."
      />

      {data.groups.map((g) => {
        const rows = data.settings.filter((s) => s.group === g.group)
        if (!rows.length) return null
        return (
          <section key={g.group} className="space-y-4">
            <div>
              <h2 className="font-heading text-base font-medium tracking-tight text-foreground">
                {g.title}
              </h2>
              <p className="text-xs text-muted-foreground">{g.blurb}</p>
            </div>

            <div className="space-y-5 rounded-xl border border-border bg-card p-5 shadow-xs">
              {rows.map((s) => (
                <div key={s.key} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={s.key}>{s.label}</Label>
                    <Badge variant={s.source === "db" ? "default" : "secondary"}>
                      {s.source === "db" ? "Set by admin" : "From env"}
                    </Badge>
                    {draft[s.key] !== s.value && <Badge variant="outline">Unsaved</Badge>}
                  </div>
                  <Input
                    id={s.key}
                    type={s.kind === "number" ? "number" : "text"}
                    min={s.min ?? undefined}
                    max={s.max ?? undefined}
                    value={draft[s.key] ?? ""}
                    disabled={saving}
                    onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {s.help} Falls back to <code>{s.envVar}</code>
                    {s.source === "env" ? (
                      <> (currently <code>{s.envDefault}</code>).</>
                    ) : (
                      <>
                        , which is <code>{s.envDefault}</code>.
                        {s.updatedByEmail && (
                          <> Pinned by {s.updatedByEmail} on {formatDate(s.updatedAt)}.</>
                        )}
                      </>
                    )}
                  </p>
                  {/* Only shown once the field is actually dirty. A warning that
                      is always on screen is a warning nobody reads; one that
                      appears the moment you change the value is a warning about
                      the change you are making. */}
                  {s.danger && draft[s.key] !== s.value && (
                    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                      <span className="font-medium">Careful: </span>
                      {s.danger}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        )
      })}

      <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-background py-4">
        <Button onClick={() => void save()} disabled={!changed.length || saving}>
          Save {changed.length ? `(${changed.length})` : ""}
        </Button>
        {!!changed.length && (
          <Button variant="ghost" onClick={() => setDraft(draftFrom(data))} disabled={saving}>
            Discard changes
          </Button>
        )}
        {pinned && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" className="ml-auto" disabled={saving}>
                <ArrowCounterClockwise />
                Reset all to env
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset every setting?</AlertDialogTitle>
                <AlertDialogDescription>
                  Drops all admin overrides on this page. Every setting reverts to its
                  environment variable. The OpenCode chat model is managed separately and
                  is not affected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void resetAll()}>Reset</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="flex items-center gap-1.5 font-heading text-base font-medium tracking-tight text-foreground">
            <Lock className="size-4 text-muted-foreground" />
            Environment
          </h2>
          <p className="text-xs text-muted-foreground">
            Read-only. These are fixed at boot or are secrets, so they can't be changed
            here. Secret values are masked and never sent in full.
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          {data.environment.map((e, i) => (
            <div
              key={e.name}
              className={`flex items-baseline gap-3 px-3 py-2 text-xs ${
                i % 2 ? "bg-muted/40" : ""
              }`}
            >
              <code className="w-64 shrink-0 text-foreground">{e.name}</code>
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                {e.isSet ? e.value : <em className="not-italic opacity-60">not set</em>}
              </span>
              {e.secret && <Badge variant="secondary">secret</Badge>}
              {e.note && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help text-muted-foreground">ⓘ</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{e.note}</TooltipContent>
                </Tooltip>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
