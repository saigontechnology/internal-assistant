import { useState, type ReactNode } from "react"
import { CaretLeft, CaretRight } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Panel } from "./admin-ui"

export interface DataTableColumn<T> {
  /** Stable column id — also the React key for its cells. */
  key: string
  header: ReactNode
  /** Applied to the <th>. */
  headClassName?: string
  /** Applied to every <td> in the column. */
  cellClassName?: string
  cell: (row: T) => ReactNode
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  rowClassName?: (row: T) => string | undefined
  /**
   * Client-side pagination: slices `rows` and renders a pager under the
   * table. Omit when the caller pages server-side (pass `footer` instead,
   * e.g. a Load-more button).
   */
  pageSize?: number
  /** Pinned inside the panel below the table, outside the scroll region. */
  footer?: ReactNode
}

/**
 * The admin portal's standard table: a Panel with a sticky header and an
 * internally scrolling body. Needs a bounded-height parent (the pages'
 * `h-full min-h-0` chains) — in normal flow the panel grows with its rows
 * and nothing scrolls or sticks.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowClassName,
  pageSize,
  footer,
}: DataTableProps<T>) {
  const [page, setPage] = useState(0)

  // Clamped so the view stays valid when the list shrinks (e.g. a patch
  // response replacing the array) while the user sits on the last page.
  const pageCount = pageSize ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1
  const safePage = Math.min(page, pageCount - 1)
  const visible = pageSize
    ? rows.slice(safePage * pageSize, (safePage + 1) * pageSize)
    : rows

  return (
    <Panel className="flex min-h-0 flex-1 flex-col">
      <Table containerClassName="min-h-0 flex-1">
        <TableHeader sticky className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            {columns.map((c) => (
              <TableHead key={c.key} className={c.headClassName}>
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((row) => (
            <TableRow key={rowKey(row)} className={rowClassName?.(row)}>
              {columns.map((c) => (
                <TableCell key={c.key} className={c.cellClassName}>
                  {c.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {pageSize !== undefined && rows.length > pageSize && (
        <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, rows.length)} of{" "}
            {rows.length}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
              aria-label="Previous page"
            >
              <CaretLeft />
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">
              Page {safePage + 1} of {pageCount}
            </span>
            <Button
              variant="ghost"
              size="icon"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
              aria-label="Next page"
            >
              <CaretRight />
            </Button>
          </div>
        </div>
      )}

      {footer}
    </Panel>
  )
}
