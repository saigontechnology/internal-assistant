import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"

export type AppView = "chat" | "sharepoint"

interface AppViewContextValue {
  view: AppView
  setView: (v: AppView) => void
  docsRefreshToken: number
  refreshDocuments: () => void
  isSidebarOpen: boolean
  openSidebar: () => void
  closeSidebar: () => void
  toggleSidebar: () => void
}

const AppViewContext = createContext<AppViewContextValue | null>(null)

export function AppViewProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<AppView>("chat")
  const [docsRefreshToken, setDocsRefreshToken] = useState(0)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)

  const refreshDocuments = useCallback(() => {
    setDocsRefreshToken((n) => n + 1)
  }, [])

  const openSidebar = useCallback(() => setIsSidebarOpen(true), [])
  const closeSidebar = useCallback(() => setIsSidebarOpen(false), [])
  const toggleSidebar = useCallback(() => setIsSidebarOpen((v) => !v), [])

  const value = useMemo<AppViewContextValue>(
    () => ({
      view,
      setView,
      docsRefreshToken,
      refreshDocuments,
      isSidebarOpen,
      openSidebar,
      closeSidebar,
      toggleSidebar,
    }),
    [view, docsRefreshToken, refreshDocuments, isSidebarOpen, openSidebar, closeSidebar, toggleSidebar]
  )

  return <AppViewContext.Provider value={value}>{children}</AppViewContext.Provider>
}

export function useAppView() {
  const ctx = useContext(AppViewContext)
  if (!ctx) throw new Error("useAppView must be used within AppViewProvider")
  return ctx
}
