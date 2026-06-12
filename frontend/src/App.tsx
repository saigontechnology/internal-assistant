import { Header } from "@/components/layout/header"
import { Sidebar } from "@/components/layout/sidebar"
import { ChatPanel } from "@/components/chat/chat-panel"
import { SharePointBrowser } from "@/components/documents/sharepoint-browser"
import { LoginPage } from "@/components/auth/login-page"
import { ConversationProvider } from "@/lib/conversations"
import { AppViewProvider, useAppView } from "@/lib/app-view"
import { useAuth } from "@/lib/auth"

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

export default function App() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  return isAuthenticated ? <AuthedApp /> : <LoginPage />
}
