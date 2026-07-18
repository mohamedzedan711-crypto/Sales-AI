-- ============================================================
-- Social Practice AI — Schema v5
-- Adds automation_failures: a visible record of anything that goes wrong
-- inside the cron/webhook-invoked backend functions (sync-hubspot-leads,
-- pull-transcripts, check-booking-replies, qualify-lead). Those functions
-- run unattended — their HTTP response bodies are never read by anyone —
-- so without this, a real failure (bad HubSpot match, expired credential,
-- API error) would only ever show up in Supabase's own function logs and
-- Mary would have no way to know something silently stopped working.
-- Run this AFTER v1/v2/v3/v4. Safe to re-run (IF NOT EXISTS guards).
-- ============================================================

create table if not exists automation_failures (
  id uuid default gen_random_uuid() primary key,
  automation text not null,
  detail text not null,
  lead_id uuid references leads(id) on delete set null,
  occurred_at timestamptz default now(),
  resolved boolean default false
);

alter table automation_failures enable row level security;
create policy "allow all" on automation_failures for all using (true);
