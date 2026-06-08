import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { chatRoute } from "./routes/chat.js";
import { documentsRoute } from "./routes/documents.js";
import { authRoute } from "./routes/auth.js";
import { sharepointRoute } from "./routes/sharepoint.js";

const app = new Hono();

app.use(
  "/api/*",
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);

app.route("/api", chatRoute);
app.route("/api/documents", documentsRoute);
app.route("/api/auth", authRoute);
app.route("/api/sharepoint", sharepointRoute);

app.get("/api/health", (c) => {
  return c.json({ status: "ok", service: "internal-assistant" });
});

const port = 8000;
console.log(`Internal Assistant backend running on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
