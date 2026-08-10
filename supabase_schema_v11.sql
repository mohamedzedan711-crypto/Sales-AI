-- ============================================================
-- Social Practice AI — Schema v11
-- Adds hubspot_sync_state: a singleton row storing the incremental sync
-- cursor for the new sync-hubspot-contacts function. Distinct from
-- sync-hubspot-leads (which has no cursor and is untouched by this
-- migration) — this is a separate, second HubSpot sync path by design.
--
-- last_synced_at defaults to epoch (1970-01-01) so the very first run
-- picks up every contact HubSpot has, since "modified after epoch" is
-- unconditionally true. sync-hubspot-contacts reads this value at the
-- start of each run and updates it to the run's start time only after a
-- fully successful (non-dry-run) pass.
--
-- Run this AFTER v1-v10. Safe to re-run (IF NOT EXISTS / ON CONFLICT
-- guards).
-- ============================================================

create table if not exists hubspot_sync_state (
  id int primary key default 1 check (id = 1),
  last_synced_at timestamptz not null default '1970-01-01T00:00:00Z',
  updated_at timestamptz default now()
);
insert into hubspot_sync_state (id, last_synced_at) values (1, '1970-01-01T00:00:00Z') on conflict (id) do nothing;

-- Same lockdown as api_credentials / oauth_states / read_ai_tokens: RLS
-- enabled, zero anon/authenticated policies on purpose. Only Edge
-- Functions running with the service-role key (which bypasses RLS
-- entirely) can read or write this table.
alter table hubspot_sync_state enable row level security;
