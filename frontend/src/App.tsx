import { Route, Routes } from "react-router-dom"
import { Header } from "@/components/layout/header"
import { Sidebar } from "@/components/layout/sidebar"
import { ChatPanel } from "@/components/chat/chat-panel"
import { SharePointBrowser } from "@/components/documents/sharepoint-browser"
import { LoginPage } from "@/components/auth/login-page"
import { AdminApp } from "@/components/admin/admin-app"
import { ConversationProvider } from "@/lib/conversations"
import { AppViewProvider, useAppView } from "@/lib/app-view"
import { useAuth } from "@/lib/auth"

function MainContent() {
  const { view } = useAppView()
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      {view === "sharepoint" ? <SharePointBrowser /> : <ChatPanel />}
    </main>
  )
}

function MobileBackdrop() {
  const { isSidebarOpen, closeSidebar } = useAppView()
  if (!isSidebarOpen) return null
  return (
    <div
      onClick={closeSidebar}
      aria-hidden="true"
      className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden animate-in fade-in"
    />
  )
}

function AuthedApp() {
  return (
    <ConversationProvider>
      <AppViewProvider>
        <div className="flex h-screen overflow-hidden">
          <Sidebar />
          <MobileBackdrop />
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
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

  if (!isAuthenticated) return <LoginPage />

  // The chat app keeps its own context-driven view switching and stays mounted
  // at every non-admin path, so no existing URL behavior changes.
  return (
    <Routes>
      <Route path="/admin/*" element={<AdminApp />} />
      <Route path="*" element={<AuthedApp />} />
    </Routes>
  )
}
