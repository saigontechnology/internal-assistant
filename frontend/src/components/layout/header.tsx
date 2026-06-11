import { LogOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/layout/theme-toggle"
import { useAuth } from "@/lib/auth"

export function Header() {
  const { user, isAuthenticated, logout } = useAuth()

  return (
    <header className="flex h-16 items-center gap-3.5 border-b border-border bg-card px-6">
      <div className="ml-auto flex items-center gap-3">
        <ThemeToggle />
        {isAuthenticated && user && (
          <div className="flex items-center gap-2 border-l border-border pl-3">
            <span className="text-sm font-medium text-foreground">
              {user.name ?? user.username}
            </span>
            <Button variant="ghost" size="icon-xs" onClick={logout}>
              <LogOut />
            </Button>
          </div>
        )}
      </div>
    </header>
  )
}
