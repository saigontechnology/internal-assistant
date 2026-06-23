import { useCallback, useEffect, useState } from "react"
import { Header } from "@/components/layout/header"
import { Sidebar } from "@/components/layout/sidebar"
import { ChatPanel } from "@/components/chat/chat-panel"
import { SharePointBrowser } from "@/components/documents/sharepoint-browser"
import { LoginPage } from "@/components/auth/login-page"
import { FirstTimeSetup } from "@/components/auth/first-time-setup"
import { ConversationProvider } from "@/lib/conversations"
import { AppViewProvider, useAppView } from "@/lib/app-view"
import { useAuth } from "@/lib/auth"
import { fetchUserPermission, type UserPermissionStatus } from "@/lib/api"

function MainContent() {
  const { view } = useAppView()
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {view === "sharepoint" ? <SharePointBrowser /> : <ChatPanel />}
    </main>
  )
}

function AuthedApp() {
  return (
    <ConversationProvider>
      <AppViewProvider>
        <div className="flex h-screen overflow-hidden">
          <Sidebar />
          <div className="flex flex-1 flex-col overflow-hidden">
            <Header />
            <MainContent />
          </div>
        </div>
      </AppViewProvider>
    </ConversationProvider>
  )
}

/**
 * Gate the chat UI on the user's permission row. While `firstSyncing` is true
 * we render <FirstTimeSetup /> instead. A page refresh during setup lands
 * back on the setup screen because the gate is driven by server state.
 */
function PermissionGate() {
  const [permission, setPermission] = useState<UserPermissionStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const perm = await fetchUserPermission()
      setPermission(perm)
    } catch (err) {
      setLoadError((err as Error).message ?? "Failed to load permission status")
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  if (loadError) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6 text-sm text-destructive">
        {loadError}
      </div>
    )
  }

  if (!permission) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  if (permission.firstSyncing || !permission.hasRecord) {
    return <FirstTimeSetup initial={permission} onReady={reload} />
  }

  return <AuthedApp />
}

export default function App() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  return isAuthenticated ? <PermissionGate /> : <LoginPage />
}
