import type { ComponentType, ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Shared page furniture for the admin portal. Every page opens with the same
 * editorial header — a mono eyebrow over a Fraunces title — so the section
 * reads as one document room rather than five unrelated screens.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 space-y-1">
        <p className="label-eyebrow text-muted-foreground">{eyebrow}</p>
        <h1 className="font-heading text-2xl font-medium tracking-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * A compact metric tile. A flat card — the accent is a single tinted icon
 * chip, no gradients. Numbers use tabular figures so a row of them aligns.
 */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ComponentType<{ className?: string; weight?: "regular" | "fill" | "bold" }>
  tone?: "default" | "primary" | "destructive"
}) {
  const chip = {
    default: "bg-muted text-muted-foreground",
    primary: "bg-primary/12 text-primary",
    destructive: "bg-destructive/10 text-destructive",
  }[tone]

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
      {Icon && (
        <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", chip)}>
          <Icon className="size-[1.1rem]" weight="bold" />
        </div>
      )}
      <div className="min-w-0">
        <p className="label-eyebrow text-muted-foreground">{label}</p>
        <p className="mt-0.5 font-heading text-xl font-medium tabular text-foreground">{value}</p>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  )
}

/** A framed surface for tables and forms — one consistent card shell. */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card shadow-xs",
        className,
      )}
    >
      {children}
    </div>
  )
}

/** The standard inline error banner used across the admin pages. */
export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
      {children}
    </div>
  )
}
