-- Promote hong.hoang@saigontechnology.com to the admin role.
--
-- Matched case-insensitively: `user_permissions.email` stores whatever casing
-- MSAL hands us in `account.username`, which the tenant may return mixed-case
-- (e.g. "Hong.Hoang@saigontechnology.com").
--
-- Deliberately an UPDATE, never an INSERT. Seeding a row keyed on the
-- lowercased email would collide with the mixed-case row MSAL creates at
-- login, leaving two rows for one human — the same reason
-- AdminRoleService.promoteBootstrapAdmins() only ever updates. If this user
-- has not signed in yet the statement is a no-op; add them to ADMIN_EMAILS so
-- promoteIfBootstrapAdmin() catches them on first login instead.
--
-- Idempotent, and consistent with the portal's promote-only rule: re-running
-- it never demotes anyone.

UPDATE "user_permissions"
   SET "role" = 'admin',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE lower("email") = 'hong.hoang@saigontechnology.com'
   AND "role" <> 'admin';
