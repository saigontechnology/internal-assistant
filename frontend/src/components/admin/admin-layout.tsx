import type { ReactNode } from "react"
import { ArrowLeft, Robot, FileText, LinkSimple, GearSix, Users, SignOut } from "@phosphor-icons/react"
import { NavLink, Link } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ThemeToggle } from "@/components/layout/theme-toggle"
import { useAuth } from "@/lib/auth"
import { cn } from "@/lib/utils"
import logoUrlWhite from "@/assets/logo_white.svg"

const NAV = [
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/documents", label: "Documents", icon: FileText },
  { to: "/admin/links", label: "Links", icon: LinkSimple },
  { to: "/admin/chat-model", label: "Chat model", icon: Robot },
  { to: "/admin/settings", label: "Settings", icon: GearSix },
]

export function AdminLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const initial = (user?.username ?? "?").charAt(0).toUpperCase()

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-screen overflow-hidden bg-background">
        {/* The navy spine — same surface as the main app's sidebar, so the
            admin portal reads as the same product with its lights on. */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
          <div className="flex h-16 items-center gap-2.5 border-b border-sidebar-border px-5">
            <img
              src={logoUrlWhite}
              alt="Internal Assistant"
              className="h-7 w-auto shrink-0"
              draggable={false}
            />
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-bold tracking-wide">INTERNAL ASSISTANT</span>
              <span className="label-eyebrow text-sidebar-primary">Admin portal</span>
            </div>
          </div>

          <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  cn(
                    "relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-sidebar-accent font-medium text-sidebar-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-sidebar-primary" />
                    )}
                    <Icon
                      className={cn("size-[1.1rem] shrink-0", isActive && "text-sidebar-primary")}
                      weight={isActive ? "fill" : "regular"}
                    />
                    {label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="border-t border-sidebar-border p-3">
            <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary/20 font-heading text-sm font-semibold text-sidebar-primary">
                {initial}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-sidebar-foreground">
                  {user?.username}
                </p>
                <p className="label-eyebrow text-sidebar-foreground/50">Administrator</p>
              </div>
            </div>
            <div className="mt-1 flex flex-col gap-0.5">
              <Link
                to="/"
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
              >
                <ArrowLeft className="size-[1.1rem] shrink-0" />
                Back to app
              </Link>
              <button
                onClick={logout}
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
              >
                <SignOut className="size-[1.1rem] shrink-0" />
                Sign out
              </button>
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-card/60 px-4 backdrop-blur-sm sm:px-6">
            {/* Mobile nav — the sidebar is hidden below md. */}
            <div className="flex items-center gap-2 md:hidden">
              <span className="label-eyebrow mr-1 text-muted-foreground">Admin</span>
              <nav className="flex items-center gap-1">
                {NAV.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    aria-label={label}
                    className={({ isActive }) =>
                      cn(
                        "rounded-lg p-2 transition-colors",
                        isActive
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-muted",
                      )
                    }
                  >
                    <Icon className="size-[1.15rem]" />
                  </NavLink>
                ))}
              </nav>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <ThemeToggle />
              <Button variant="ghost" size="sm" asChild className="md:hidden">
                <Link to="/">
                  <ArrowLeft />
                  Back
                </Link>
              </Button>
            </div>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8 sm:py-8">
            <div className="mx-auto max-w-6xl">{children}</div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  )
}
