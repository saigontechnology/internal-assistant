import { Monitor, Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTheme, type Theme } from "@/lib/theme"

const NEXT: Record<Theme, Theme> = {
  light: "dark",
  dark: "system",
  system: "light",
}

const LABEL: Record<Theme, string> = {
  light: "Light theme",
  dark: "Dark theme",
  system: "System theme",
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const label = LABEL[theme]

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={() => setTheme(NEXT[theme])}
      aria-label={`${label} (click to switch)`}
      title={`${label} (click to switch)`}
    >
      {theme === "light" && <Sun />}
      {theme === "dark" && <Moon />}
      {theme === "system" && <Monitor />}
    </Button>
  )
}
