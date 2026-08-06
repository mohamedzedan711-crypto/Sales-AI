-- ============================================================
-- Social Practice AI — Schema v9
-- Locks down system_settings so the auto-send kill switch can only be
-- changed through the new set-auto-send Edge Function (admin-password
-- gated, same ADMIN_PANEL_PASSWORD used by Settings -> Integrations),
-- never directly from the browser with the anon key. Replaces v8's
-- permissive "allow all" policy with anon-read-only — reading the current
-- state needs no password (matches get-credentials-status's read-only
-- precedent), but writes require the admin function. Edge Functions using
-- the service-role key (every check in _shared/autoSend.ts, and
-- set-auto-send itself) bypass RLS regardless, so this only closes the
-- direct-from-browser write path. Run this AFTER v1-v8. Safe to re-run.
-- ============================================================

drop policy if exists "allow all" on system_settings;

create policy "anon read only" on system_settings for select using (true);
