-- ============================================================
-- Social Practice AI — Schema v10
-- Read.ai OAuth 2.1 scaffold. client_id/client_secret don't exist yet —
-- this only prepares storage so the read-ai-authorize /
-- read-ai-oauth-callback Edge Functions have somewhere to read/write.
--
-- 1. read_ai_tokens: token store for Read.ai's OAuth access_token /
--    refresh_token. Kept as its own table (rather than reusing
--    api_credentials, which is where Gmail's refresh token lives) because
--    Read.ai's OAuth 2.1 flow has a real access_token + expires_at to
--    track, unlike Gmail's refresh-token-only model where a fresh access
--    token is fetched on demand and never stored.
--
-- 2. oauth_states.code_verifier: OAuth 2.1 requires PKCE — the
--    code_verifier generated in read-ai-authorize has to survive until
--    read-ai-oauth-callback completes the token exchange. Reuses the
--    existing oauth_states table (same >10min sweep, same
--    validate-then-delete pattern Gmail's flow already established)
--    rather than adding a second near-duplicate state table. Nullable:
--    Gmail's flow never sets it and is unaffected by this column existing.
--
-- Run this AFTER v1-v9. Safe to re-run (IF NOT EXISTS guards).
-- ============================================================

create table if not exists read_ai_tokens (
  id uuid primary key default gen_random_uuid(),
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz
);

-- Same lockdown as api_credentials / oauth_states: RLS enabled, zero
-- anon/authenticated policies on purpose. Only Edge Functions running
-- with the service-role key (which bypasses RLS entirely) can read or
-- write this table — there is no direct access from the browser.
alter table read_ai_tokens enable row level security;

alter table oauth_states add column if not exists code_verifier text;
