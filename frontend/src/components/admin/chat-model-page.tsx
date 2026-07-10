import { useCallback, useEffect, useState } from "react"
import { AlertCircle, RefreshCw, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
  applyPrefix,
  fetchChatModelSettings,
  resetChatModelConfig,
  updateChatModelConfig,
  LADDER_RUNGS,
  type ChatModelInput,
  type ChatModelSettings,
} from "@/lib/admin-api"

function draftFrom(settings: ChatModelSettings): ChatModelInput {
  const byRung = Object.fromEntries(settings.ladder.map((r) => [r.rung, r.value]))
  return {
    primary: byRung.primary ?? "",
    fallback: byRung.fallback ?? "",
    secondFallback: byRung.secondFallback ?? "",
    prefix: settings.prefix.value,
  }
}

function formatDate(value: string | null): string {
  if (!value) return ""
  return new Date(value).toLocaleString()
}

export function AdminChatModelPage() {
  const [settings, setSettings] = useState<ChatModelSettings | null>(null)
  const [draft, setDraft] = useState<ChatModelInput | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    try {
      const next = await fetchChatModelSettings(refresh)
      setSettings(next)
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

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      await updateChatModelConfig(draft)
      toast.success("Chat model updated. New chats use it within 30 seconds.")
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    setSaving(true)
    try {
      await resetChatModelConfig()
      toast.success("Reverted to the models configured in the environment.")
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const dirty =
    !!settings &&
    !!draft &&
    (settings.prefix.value !== draft.prefix.trim() ||
      settings.ladder.some((r) => draft[r.rung] !== r.value))

  const pinned =
    !!settings &&
    (settings.prefix.source === "db" || settings.ladder.some((r) => r.source === "db"))

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Chat model</h1>
          <p className="text-sm text-muted-foreground">
            The OpenCode fallback ladder. Each rung is tried in order; a rung that
            returns a rate limit cools down for 60 seconds and the next one takes over.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load(true)}
          disabled={loading || saving}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          Refresh catalog
        </Button>
      </div>

      {settings && !settings.active && (
        <div className="flex gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <p className="text-foreground">
            <code>CHAT_PROVIDER</code> is <strong>{settings.provider}</strong>, not{" "}
            <code>opencode</code>. You can set the model here, but chat will keep using
            the {settings.provider} models until the environment variable changes.
          </p>
        </div>
      )}

      {settings?.catalogError && (
        <div className="flex gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-foreground">{settings.catalogError}</p>
        </div>
      )}

      {loading && !settings ? (
        <div className="space-y-4">
          <Skeleton className="h-20 w-full" />
          {LADDER_RUNGS.map((r) => (
            <Skeleton key={r.rung} className="h-20 w-full" />
          ))}
        </div>
      ) : settings && draft ? (
        <>
          <div className="space-y-1.5 rounded-md border border-border p-4">
            <div className="flex items-center gap-2">
              <Label htmlFor="prefix">Model prefix</Label>
              <Badge variant={settings.prefix.source === "db" ? "default" : "secondary"}>
                {settings.prefix.source === "db" ? "Set by admin" : "Default"}
              </Badge>
            </div>
            <Input
              id="prefix"
              value={draft.prefix}
              placeholder="opencode-go"
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, prefix: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Prepended to every model below when calling the gateway. The catalog lists
              bare ids, so the prefix is stored separately — changing it doesn't change
              which models are picked. Leave empty to send bare ids. Default:{" "}
              <code>{settings.prefix.envDefault}</code>.
              {settings.prefix.source === "db" && settings.prefix.updatedByEmail && (
                <> Pinned by {settings.prefix.updatedByEmail} on{" "}
                  {formatDate(settings.prefix.updatedAt)}.</>
              )}
            </p>
          </div>

          <div className="space-y-5">
            {LADDER_RUNGS.map(({ rung, label, hint }) => {
              const detail = settings.ladder.find((r) => r.rung === rung)!
              // A stored value the gateway no longer offers can't be a Select
              // option, so surface it explicitly rather than rendering blank.
              const missing = detail.inCatalog === false

              return (
                <div key={rung} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`rung-${rung}`}>{label}</Label>
                    <Badge variant={detail.source === "db" ? "default" : "secondary"}>
                      {detail.source === "db" ? "Set by admin" : "From env"}
                    </Badge>
                    {missing && <Badge variant="destructive">Not in catalog</Badge>}
                  </div>

                  <Select
                    value={draft[rung]}
                    disabled={saving || settings.models.length === 0}
                    onValueChange={(value) => setDraft({ ...draft, [rung]: value })}
                  >
                    <SelectTrigger id={`rung-${rung}`} className="w-full">
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {/* Keep an unknown current value selectable so opening the
                          dropdown doesn't silently rewrite it. */}
                      {missing && (
                        <SelectItem value={detail.value}>
                          {detail.value} (unavailable)
                        </SelectItem>
                      )}
                      {settings.models.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <p className="text-xs text-muted-foreground">
                    {hint} Sent as <code>{applyPrefix(draft.prefix, draft[rung])}</code>.
                    {detail.source === "db" && detail.updatedByEmail && (
                      <> Pinned by {detail.updatedByEmail} on {formatDate(detail.updatedAt)}.</>
                    )}
                    {detail.source === "env" && (
                      <> Default: <code>{detail.envDefault}</code>.</>
                    )}
                  </p>
                </div>
              )
            })}
          </div>

          <div className="flex items-center gap-2 border-t border-border pt-4">
            <Button onClick={() => void save()} disabled={!dirty || saving}>
              Save
            </Button>
            {dirty && (
              <Button
                variant="ghost"
                onClick={() => setDraft(draftFrom(settings))}
                disabled={saving}
              >
                Discard changes
              </Button>
            )}

            {pinned && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" className="ml-auto" disabled={saving}>
                    <RotateCcw />
                    Reset to env
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Reset to defaults?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Drops the pinned prefix and all three models. The prefix reverts to{" "}
                      <code>{settings.prefix.envDefault || "(none)"}</code> and the models
                      to whatever the <code>OPENCODE_CHAT_*_MODEL</code> vars are set to on
                      the server — which may not be models the gateway still offers.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void reset()}>Reset</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
