import type { ReactNode } from "react"
import { ArrowLeft, Bot, FileText, Link2, Settings, Users } from "lucide-react"
import { NavLink, Link } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ThemeToggle } from "@/components/layout/theme-toggle"
import { useAuth } from "@/lib/auth"
import { cn } from "@/lib/utils"

const NAV = [
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/documents", label: "Documents", icon: FileText },
  { to: "/admin/links", label: "Links", icon: Link2 },
  { to: "/admin/chat-model", label: "Chat model", icon: Bot },
  { to: "/admin/settings", label: "Settings", icon: Settings },
]

export function AdminLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()

  return (
    <TooltipProvider delayDuration={150}>
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card p-4 md:flex">
        <div className="mb-6 px-2">
          <p className="text-sm font-semibold text-foreground">Admin portal</p>
          <p className="truncate text-xs text-muted-foreground">{user?.username}</p>
        </div>

        <nav className="flex flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-1">
          <Button variant="ghost" size="sm" className="justify-start" asChild>
            <Link to="/">
              <ArrowLeft />
              Back to app
            </Link>
          </Button>
          <Button variant="ghost" size="sm" className="justify-start" onClick={logout}>
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-card px-4 sm:px-6">
          {/* Mobile nav — the sidebar is hidden below md. */}
          <nav className="flex items-center gap-1 md:hidden">
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                aria-label={label}
                className={({ isActive }) =>
                  cn(
                    "rounded-md p-2",
                    isActive ? "bg-muted text-foreground" : "text-muted-foreground",
                  )
                }
              >
                <Icon className="size-4" />
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            <Button variant="ghost" size="sm" asChild className="md:hidden">
              <Link to="/">Back</Link>
            </Button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
    </TooltipProvider>
  )
}
