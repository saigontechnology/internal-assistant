import { SignOut, List, ShieldCheck } from "@phosphor-icons/react"
import { Link } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/layout/theme-toggle"
import { useAuth } from "@/lib/auth"
import { useAppView } from "@/lib/app-view"

export function Header() {
  const { user, isAuthenticated, logout } = useAuth()
  const { toggleSidebar } = useAppView()

  return (
    <header className="flex h-16 items-center gap-3.5 border-b border-border bg-card px-4 sm:px-6">
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleSidebar}
        aria-label="Toggle sidebar"
        className="lg:hidden"
      >
        <List />
      </Button>
      <div className="ml-auto flex items-center gap-3">
        {user?.isAdmin && (
          <Button variant="ghost" size="sm" asChild>
            <Link to="/admin">
              <ShieldCheck />
              <span className="hidden sm:inline">Admin</span>
            </Link>
          </Button>
        )}
        <ThemeToggle />
        {isAuthenticated && user && (
          <div className="flex items-center gap-2 border-l border-border pl-3">
            <span className="text-sm font-medium text-foreground sm:inline">
              {user.name ?? user.username}
            </span>
            <Button variant="ghost" size="icon-xs" onClick={logout} aria-label="Log out">
              <SignOut />
            </Button>
          </div>
        )}
      </div>
    </header>
  )
}
