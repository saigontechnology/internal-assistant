import { Header } from "@/components/layout/header"
import { Sidebar } from "@/components/layout/sidebar"
import { ChatPanel } from "@/components/chat/chat-panel"
import { SharePointBrowser } from "@/components/documents/sharepoint-browser"
import { ConversationProvider } from "@/lib/conversations"
import { AppViewProvider, useAppView } from "@/lib/app-view"

function MainContent() {
  const { view } = useAppView()
  return (
    <main className="flex flex-1 flex-col">
      {view === "sharepoint" ? <SharePointBrowser /> : <ChatPanel />}
    </main>
  )
}

export default function App() {
  return (
    <ConversationProvider>
      <AppViewProvider>
        <div className="flex h-screen flex-col">
          <Header />
          <div className="flex flex-1 overflow-hidden">
            <Sidebar />
            <MainContent />
          </div>
        </div>
      </AppViewProvider>
    </ConversationProvider>
  )
}
