import { Navigate, Route, Routes } from "react-router-dom"
import { useAuth } from "@/lib/auth"
import { AdminLayout } from "./admin-layout"
import { AdminUsersPage } from "./users-page"
import { AdminDocumentsPage } from "./documents-page"
import { AdminLinksPage } from "./links-page"
import { AdminChatModelPage } from "./chat-model-page"

/**
 * Entry point for `/admin/*`.
 *
 * Non-admins bounce back to the chat app. This is a convenience only — every
 * `/api/admin/*` route is independently guarded server-side by AdminGuard.
 */
export function AdminApp() {
  const { user } = useAuth()

  if (!user?.isAdmin) return <Navigate to="/" replace />

  return (
    <AdminLayout>
      <Routes>
        <Route index element={<Navigate to="users" replace />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="documents" element={<AdminDocumentsPage />} />
        <Route path="links" element={<AdminLinksPage />} />
        <Route path="chat-model" element={<AdminChatModelPage />} />
        <Route path="*" element={<Navigate to="/admin/users" replace />} />
      </Routes>
    </AdminLayout>
  )
}
