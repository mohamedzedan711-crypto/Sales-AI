-- ============================================================
-- Social Practice AI — Schema v3
-- Moves third-party API credentials out of Supabase CLI secrets
-- and into the app itself (Settings > Integrations), so deployment
-- works with all provider keys empty and each becomes live the
-- moment it's added — no redeploy needed.
-- Run this AFTER supabase_schema.sql and supabase_schema_v2.sql.
-- ============================================================

-- ---- API credentials (Anthropic, HubSpot, Read.ai, Gmail) ----
-- key_name: 'anthropic' | 'hubspot' | 'readai' | 'gmail'
-- key_value: the API key, or (for gmail) the OAuth refresh token
-- meta: small extra bits that don't fit key_value — currently only used
--       to remember which Gmail account is connected (meta->>'email')
create table if not exists api_credentials (
  key_name text primary key,
  key_value text,
  meta jsonb default '{}',
  status text default 'not_connected',   -- 'not_connected' | 'connected' | 'invalid'
  connected_at timestamptz
);

-- CRITICAL: no anon (or even authenticated) policies are created here on
-- purpose. RLS is enabled with zero grants, so the public/anon key —
-- which is what the browser and questionnaire.html use everywhere else in
-- this app — cannot read, insert, update, or delete this table at all.
-- Only Edge Functions running with the service_role key (which bypasses
-- RLS entirely) can touch it. The Settings UI never talks to this table
-- directly — it always goes through save-credential / disconnect-credential
-- / get-credentials-status, which check an admin password first.
alter table api_credentials enable row level security;

-- ---- Short-lived state for the Gmail OAuth round trip ----
-- gmail-oauth-start writes a row here before redirecting to Google;
-- gmail-oauth-callback checks it exists (and isn't stale) as CSRF
-- protection, then deletes it.
create table if not exists oauth_states (
  state text primary key,
  created_at timestamptz default now()
);
alter table oauth_states enable row level security;
-- Same as above: no anon policies. Only Edge Functions touch this table.
