import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { AuthProvider } from "./lib/auth"
import { ThemeProvider } from "./lib/theme"
import "./index.css"
import App from "./App"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>
)
