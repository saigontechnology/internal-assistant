import { useCallback, useEffect, useState } from "react"
import {
  ArrowsClockwise,
  PencilSimple,
  WarningCircle,
  Users as UsersIcon,
  ShieldCheck,
  CheckCircle,
} from "@phosphor-icons/react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  fetchAdminUsers,
  resyncAdminUser,
  updateAdminUser,
  type AdminUser,
  type UpdateUserPatch,
} from "@/lib/admin-api"
import { useAuth } from "@/lib/auth"
import { ErrorBanner, PageHeader, StatCard } from "./admin-ui"
import { DataTable, type DataTableColumn } from "./data-table"

function formatDate(value: string | null): string {
  if (!value) return "—"
  return new Date(value).toLocaleString()
}

const PAGE_SIZE = 25

export function AdminUsersPage() {
  const { user: me } = useAuth()
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<AdminUser | null>(null)

  const load = useCallback(async () => {
    try {
      setUsers(await fetchAdminUsers())
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patch = async (email: string, body: UpdateUserPatch, successMessage: string) => {
    setBusy(email)
    try {
      setUsers(await updateAdminUser(email, body))
      toast.success(successMessage)
    } catch (err) {
      toast.error((err as Error).message)
      // The optimistic switch already flipped; re-read to snap it back.
      void load()
    } finally {
      setBusy(null)
    }
  }

  const resync = async (email: string) => {
    setBusy(email)
    try {
      const { message } = await resyncAdminUser(email)
      toast.success(message)
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (error) {
    return (
      <ErrorBanner>
        <WarningCircle className="size-4 shrink-0" />
        {error}
      </ErrorBanner>
    )
  }

  if (!users) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[4.5rem] w-full rounded-xl" />
          ))}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    )
  }

  const adminCount = users.filter((u) => u.role === "admin").length
  const activeCount = users.filter((u) => u.isActive).length

  const isSelf = (u: AdminUser) =>
    u.email.toLowerCase() === (me?.username ?? "").toLowerCase()

  const columns: DataTableColumn<AdminUser>[] = [
    {
      key: "email",
      header: "Email",
      headClassName: "pl-4",
      cellClassName: "pl-4 font-medium",
      cell: (u) => (
        <>
          <div className="flex items-center gap-2">
            <span className="truncate">{u.email}</span>
            {isSelf(u) && <Badge variant="secondary">you</Badge>}
          </div>
          {u.lastError && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="mt-0.5 flex w-fit items-center gap-1 text-xs text-destructive">
                  <WarningCircle className="size-3" /> sync error
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm">{u.lastError}</TooltipContent>
            </Tooltip>
          )}
        </>
      ),
    },
    {
      key: "profile",
      header: "Job profile",
      cell: (u) => (
        <div className="flex items-center gap-2">
          <span className="text-sm">
            {u.jobTitle || "—"}
            <span className="text-muted-foreground"> · {u.department || "—"}</span>
          </span>
          {u.profileOverride && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline">pinned</Badge>
              </TooltipTrigger>
              <TooltipContent>
                Set manually. Azure AD will not overwrite it.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      key: "admin",
      header: "Admin",
      headClassName: "text-center",
      cellClassName: "text-center",
      cell: (u) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Switch
                checked={u.role === "admin"}
                disabled={busy === u.email || isSelf(u)}
                onCheckedChange={(next) =>
                  patch(
                    u.email,
                    { role: next ? "admin" : "user" },
                    next ? `${u.email} is now an admin` : `${u.email} is no longer an admin`,
                  )
                }
                aria-label="Admin role"
              />
            </span>
          </TooltipTrigger>
          {isSelf(u) && (
            <TooltipContent>You cannot remove your own admin role</TooltipContent>
          )}
        </Tooltip>
      ),
    },
    {
      key: "active",
      header: "Active",
      headClassName: "text-center",
      cellClassName: "text-center",
      cell: (u) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Switch
                checked={u.isActive}
                disabled={busy === u.email || isSelf(u)}
                onCheckedChange={(next) =>
                  patch(
                    u.email,
                    { isActive: next },
                    next ? `${u.email} reactivated` : `${u.email} deactivated`,
                  )
                }
                aria-label="Account active"
              />
            </span>
          </TooltipTrigger>
          {isSelf(u) && (
            <TooltipContent>You cannot deactivate your own account</TooltipContent>
          )}
        </Tooltip>
      ),
    },
    {
      key: "sync",
      header: "Can sync",
      headClassName: "text-center",
      cellClassName: "text-center",
      cell: (u) => (
        <Switch
          checked={u.isAllowedToSync}
          disabled={busy === u.email}
          onCheckedChange={(next) =>
            patch(
              u.email,
              { isAllowedToSync: next },
              next ? "Sync access granted" : "Sync access revoked",
            )
          }
          aria-label="Can trigger sync"
        />
      ),
    },
    {
      key: "lastSync",
      header: "Last sync",
      cellClassName: "text-sm text-muted-foreground",
      cell: (u) => formatDate(u.lastSync),
    },
    {
      key: "actions",
      header: "Actions",
      headClassName: "text-right",
      cellClassName: "text-right",
      cell: (u) => (
        <div className="flex justify-end gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={busy === u.email}
                onClick={() => setEditing(u)}
                aria-label="Edit job profile"
              >
                <PencilSimple />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Edit job profile</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={busy === u.email}
                onClick={() => resync(u.email)}
                aria-label="Force profile resync"
              >
                <ArrowsClockwise />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Force profile resync</TooltipContent>
          </Tooltip>
        </div>
      ),
    },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      <PageHeader
        eyebrow="Access control"
        title="Users"
        description="Everyone who has signed in at least once. Toggle admin, active, and sync rights, or pin a job profile."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Known users" value={users.length} icon={UsersIcon} />
        <StatCard label="Admins" value={adminCount} icon={ShieldCheck} tone="primary" />
        <StatCard
          label="Active"
          value={activeCount}
          hint={`${users.length - activeCount} deactivated`}
          icon={CheckCircle}
        />
      </div>

      <DataTable
        columns={columns}
        rows={users}
        rowKey={(u) => u.email}
        rowClassName={(u) => (u.isActive ? undefined : "opacity-55")}
        pageSize={PAGE_SIZE}
      />

      {editing && (
        <EditProfileDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            setUsers(next)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function EditProfileDialog({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUser
  onClose: () => void
  onSaved: (users: AdminUser[]) => void
}) {
  const [jobTitle, setJobTitle] = useState(user.jobTitle)
  const [department, setDepartment] = useState(user.department)
  const [saving, setSaving] = useState(false)

  const save = async (patch: UpdateUserPatch, message: string) => {
    setSaving(true)
    try {
      onSaved(await updateAdminUser(user.email, patch))
      toast.success(message)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Job profile</DialogTitle>
          <DialogDescription>
            Pinning a profile overrides what Azure AD reports and decides which documents{" "}
            {user.email} can retrieve. The new profile is scanned on their next request.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="jobTitle">Job title</Label>
            <Input
              id="jobTitle"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="Developer"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="department">Department</Label>
            <Input
              id="department"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              placeholder="SDC 1"
            />
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            disabled={saving || !user.profileOverride}
            onClick={() =>
              save({ clearProfileOverride: true }, "Profile handed back to Azure AD")
            }
          >
            Reset to Azure AD
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              disabled={saving || !jobTitle.trim() || !department.trim()}
              onClick={() => save({ jobTitle, department }, "Job profile pinned")}
            >
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
