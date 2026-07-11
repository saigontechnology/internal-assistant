import { Moon, Sun } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { useTheme } from "@/lib/theme"

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const isDark = theme === "dark"
  const label = isDark ? "Dark theme" : "Light theme"

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={`${label} (click to switch)`}
      title={`${label} (click to switch)`}
    >
      {isDark ? <Moon /> : <Sun />}
    </Button>
  )
}
