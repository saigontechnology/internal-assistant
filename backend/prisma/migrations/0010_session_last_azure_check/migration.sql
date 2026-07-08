-- Records the last time we asked MSAL to validate the session's tokens
-- against Azure AD. Combined with the sliding `expires_at` window: the
-- session cookie/TTL is the fast path, and once every N hours the
-- session guard also runs `acquireTokenSilent` so revoked / disabled
-- accounts get kicked without waiting for the outer TTL to burn down.
-- Nullable so existing sessions (created before this column) trigger a
-- check on their next request.
ALTER TABLE "sessions"
  ADD COLUMN "last_azure_check_at" TIMESTAMP(6);
