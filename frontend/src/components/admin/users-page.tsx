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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
import { ErrorBanner, PageHeader, Panel, StatCard } from "./admin-ui"

function formatDate(value: string | null): string {
  if (!value) return "—"
  return new Date(value).toLocaleString()
}

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

      <Panel className="min-h-0 flex-1">
        <Table containerClassName="h-full">
          <TableHeader sticky className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Email</TableHead>
              <TableHead>Job profile</TableHead>
              <TableHead className="text-center">Admin</TableHead>
              <TableHead className="text-center">Active</TableHead>
              <TableHead className="text-center">Can sync</TableHead>
              <TableHead>Last sync</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => {
              const isSelf = u.email.toLowerCase() === (me?.username ?? "").toLowerCase()
              const disabled = busy === u.email
              return (
                <TableRow key={u.email} className={u.isActive ? "" : "opacity-55"}>
                  <TableCell className="pl-4 font-medium">
                    <div className="flex items-center gap-2">
                      <span className="truncate">{u.email}</span>
                      {isSelf && <Badge variant="secondary">you</Badge>}
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
                  </TableCell>

                  <TableCell>
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
                  </TableCell>

                  <TableCell className="text-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <Switch
                            checked={u.role === "admin"}
                            disabled={disabled || isSelf}
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
                      {isSelf && (
                        <TooltipContent>You cannot remove your own admin role</TooltipContent>
                      )}
                    </Tooltip>
                  </TableCell>

                  <TableCell className="text-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <Switch
                            checked={u.isActive}
                            disabled={disabled || isSelf}
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
                      {isSelf && (
                        <TooltipContent>You cannot deactivate your own account</TooltipContent>
                      )}
                    </Tooltip>
                  </TableCell>

                  <TableCell className="text-center">
                    <Switch
                      checked={u.isAllowedToSync}
                      disabled={disabled}
                      onCheckedChange={(next) =>
                        patch(
                          u.email,
                          { isAllowedToSync: next },
                          next ? "Sync access granted" : "Sync access revoked",
                        )
                      }
                      aria-label="Can trigger sync"
                    />
                  </TableCell>

                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(u.lastSync)}
                  </TableCell>

                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={disabled}
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
                            disabled={disabled}
                            onClick={() => resync(u.email)}
                            aria-label="Force profile resync"
                          >
                            <ArrowsClockwise />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Force profile resync</TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Panel>

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
