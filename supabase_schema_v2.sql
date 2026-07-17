-- ============================================================
-- Social Practice AI — Schema v2
-- Adds: async qualification funnel, Mary's Voice profile,
-- reschedule tracking. Run this AFTER supabase_schema.sql.
-- Safe to re-run (uses IF NOT EXISTS / ON CONFLICT guards).
-- ============================================================

-- ---- Extend leads with qualification + booking fields ----
alter table leads add column if not exists qualified boolean;
alter table leads add column if not exists qualification_score int;
alter table leads add column if not exists qualification_reason text;
alter table leads add column if not exists questionnaire_token text unique;
alter table leads add column if not exists questionnaire_sent_at timestamptz;
alter table leads add column if not exists questionnaire_submitted_at timestamptz;
alter table leads add column if not exists meeting_proposed_at timestamptz;
alter table leads add column if not exists meeting_scheduled_at timestamptz;
-- Backfilling columns the client already writes but were never added to schema.sql:
alter table leads add column if not exists hubspot_contact_id text;
alter table leads add column if not exists hubspot_deal_id text;
alter table leads add column if not exists discovery_call_date date;
alter table leads add column if not exists signed_date date;

-- ---- Questionnaire responses (public-facing form submits here) ----
create table if not exists questionnaire_responses (
  id uuid default gen_random_uuid() primary key,
  lead_id uuid references leads(id) on delete cascade,
  token text not null,
  business_name text,
  contact_name text,
  email text,
  practice_type text,
  years_in_business text,
  current_marketing_setup text,
  monthly_new_client_volume text,
  approves_spend text,              -- 'yes' | 'someone_else'
  monthly_budget_band text,
  biggest_challenge text,
  six_month_goal text,
  start_timeline text,
  raw jsonb,                        -- full answer blob, for flexibility
  submitted_at timestamptz default now()
);

alter table questionnaire_responses enable row level security;

-- Public form can INSERT only — cannot read/update/modify anyone's data.
-- Edge Functions use the service-role key, which bypasses RLS entirely.
create policy "anon insert only" on questionnaire_responses
  for insert to anon
  with check (true);

-- ---- Qualification config (singleton row, editable from Settings) ----
create table if not exists qualification_config (
  id int primary key default 1 check (id = 1),
  min_budget_floor numeric default 0,
  ideal_budget_threshold numeric default 0,
  updated_at timestamptz default now()
);
-- Provisional starting values from Mary's VA briefing doc, NOT confirmed
-- with her directly yet — min floor = her lowest tier ($2,000/mo), ideal
-- threshold = the low end of her top tiers ($4,000-6,000/mo). Both are
-- freely editable in Settings and expected to change after she screen-
-- shares her actual process.
insert into qualification_config (id, min_budget_floor, ideal_budget_threshold)
  values (1, 2000, 4000)
  on conflict (id) do nothing;

alter table qualification_config enable row level security;
create policy "allow all" on qualification_config for all using (true);

-- ---- Mary's Voice profile (singleton row) ----
create table if not exists voice_profile (
  id int primary key default 1 check (id = 1),
  raw_samples text[] default '{}',
  tone_summary text,
  energy_level text,
  formality_level text,
  common_openers text[] default '{}',
  common_closers text[] default '{}',
  signature_phrases text[] default '{}',
  never_does text[] default '{}',
  last_updated timestamptz default now()
);
insert into voice_profile (id) values (1) on conflict (id) do nothing;

alter table voice_profile enable row level security;
create policy "allow all" on voice_profile for all using (true);

-- ---- Reschedule flags (surfaced in Inbox Manager) ----
create table if not exists reschedule_flags (
  id uuid default gen_random_uuid() primary key,
  lead_id uuid references leads(id) on delete cascade,
  detected_message text,
  raw_email_snippet text,
  status text default 'new',        -- 'new' | 'resolved'
  detected_at timestamptz default now()
);

alter table reschedule_flags enable row level security;
create policy "allow all" on reschedule_flags for all using (true);
