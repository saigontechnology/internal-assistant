const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/**
 * Parses the SharePoint list "Date" column into a Date. The upstream value is
 * a free-text field, so it comes through in a few shapes — most commonly
 * "DD-Mon-YY" ("23-Apr-25") and "DD-Mon-YYYY" ("23-Apr-2025"). Two-digit
 * years pivot at 70: <70 → 2000s, ≥70 → 1900s (matches Postgres to_date/YY).
 * Returns null when the input can't be interpreted.
 */
export function parseFileDate(input: unknown): Date | null {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (!s) return null
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(s)
  if (!m) return null
  const day = Number(m[1])
  const month = MONTHS[m[2].toLowerCase()]
  if (month === undefined) return null
  let year = Number(m[3])
  if (m[3].length === 2) year = year >= 70 ? 1900 + year : 2000 + year
  const d = new Date(Date.UTC(year, month, day))
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month ||
    d.getUTCDate() !== day
  ) {
    return null
  }
  return d
}

/** Convenience for the common shape `{ date?: unknown }` on sourceMetadata. */
export function fileDateFromSourceMetadata(md: unknown): Date | null {
  if (!md || typeof md !== 'object') return null
  return parseFileDate((md as Record<string, unknown>).date)
}
