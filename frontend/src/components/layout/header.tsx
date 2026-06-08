import { LogOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/layout/theme-toggle"
import { useAuth } from "@/lib/auth"

export function Header() {
  const { user, isAuthenticated, logout } = useAuth()

  return (
    <header className="flex h-16 items-center gap-3.5 border-b border-border bg-background/80 px-5 backdrop-blur-sm">
      <div className="flex size-9 items-center justify-center rounded-[0.4rem] bg-primary font-display text-base leading-none font-semibold text-primary-foreground shadow-sm">
        IA
      </div>
      <div className="flex flex-col leading-none">
        <h1 className="font-display text-xl leading-none font-semibold tracking-tight">
          Internal Assistant
        </h1>
        <span className="label-eyebrow mt-1 text-muted-foreground">
          Document Reading Room
        </span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <ThemeToggle />
        {isAuthenticated && user && (
          <div className="flex items-center gap-2 border-l border-border pl-3">
            <span className="text-sm text-muted-foreground">
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
