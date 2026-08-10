-- ============================================================
-- Social Practice AI — Schema v12
-- Manual Send + Automated Detection build. Adds:
--
-- 1. companies: HubSpot Company records, kept distinct from leads (a
--    lead is a person; a company is their practice) so the client-facing
--    UI can show both together. leads.company_id links a lead to its
--    practice once known — set by hubspot-webhook-receiver /
--    prospero-webhook-receiver, nullable since not every lead has a
--    linked company yet.
--
-- 2. deals: Prospero deals, matched to a lead (and optionally a company)
--    and mirrored to HubSpot as a Deal object. hubspot_deal_id is null
--    until the first successful push; prospero_deal_id is Prospero's own
--    identifier, exact field name TBD until real payloads are seen (see
--    prospero-webhook-receiver's extraction comments).
--
-- 3. prospero_events: every raw Prospero webhook payload, logged
--    verbatim before any parsing is attempted — so nothing is lost while
--    field-mapping is finalized against real payloads.
--
-- 4. templates: canned outreach copy, grouped by category, with merge
--    fields filled in at send time by send-template. Seeded with
--    placeholder rows only — real copy comes later from the brand voice
--    guide (referenced as voice.md in the spec; not present in this repo
--    yet). name is unique so the seed insert can be safely re-run.
--
-- 5. leads.qualification_override / _reason / _by / _at: a human decision
--    layered ON TOP of the existing deterministic qualified /
--    qualification_score / qualification_reason columns (untouched,
--    still written only by qualify-lead) — both are visible at once,
--    neither overwrites the other. Nullable; null means no override has
--    been made.
--
-- Run this AFTER v1-v11. Safe to re-run (IF NOT EXISTS / ON CONFLICT
-- guards; policies are dropped and recreated rather than using
-- "IF NOT EXISTS", which CREATE POLICY doesn't support in Postgres).
-- ============================================================

create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  hubspot_company_id text unique,
  name text,
  domain text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table companies enable row level security;
drop policy if exists "allow all" on companies;
create policy "allow all" on companies for all using (true);

alter table leads add column if not exists company_id uuid references companies(id);

create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete cascade,
  company_id uuid references companies(id),
  hubspot_deal_id text,
  prospero_deal_id text,
  name text,
  stage text,
  value numeric,
  status text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table deals enable row level security;
drop policy if exists "allow all" on deals;
create policy "allow all" on deals for all using (true);

create table if not exists prospero_events (
  id uuid primary key default gen_random_uuid(),
  raw_payload jsonb not null,
  received_at timestamptz default now(),
  processed boolean default false,
  processing_error text
);
alter table prospero_events enable row level security;
drop policy if exists "allow all" on prospero_events;
create policy "allow all" on prospero_events for all using (true);

create table if not exists templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  category text not null,
  subject text not null,
  body text not null,
  sort_order int default 0,
  active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
-- RLS deliberately more open than companies/deals/prospero_events: the
-- frontend's Templates picker reads this table directly with the anon
-- key (same pattern as qualification_config, voice_profile before it was
-- removed) — there's nothing sensitive in canned copy. Writes still only
-- happen from the SQL editor / a future admin UI, not from send-template
-- or any automated path.
alter table templates enable row level security;
drop policy if exists "allow all" on templates;
create policy "allow all" on templates for all using (true);

insert into templates (name, category, subject, body, sort_order) values
  ('Qualification Email', 'qualification', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 0),
  ('Lead Generation', 'lead_gen', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 0),
  ('Booking Meeting', 'booking', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 0),
  ('Follow-up 1', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 1),
  ('Follow-up 2', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 2),
  ('Follow-up 3', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 3),
  ('Follow-up 4', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 4),
  ('Follow-up 5', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 5),
  ('Follow-up 6', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 6),
  ('Follow-up 7', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 7),
  ('Follow-up 8', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 8),
  ('Follow-up 9', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 9),
  ('Follow-up 10', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 10),
  ('Follow-up 11', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 11),
  ('Follow-up 12', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 12),
  ('Follow-up 13', 'follow_up', 'Subject TBD — placeholder', 'Placeholder body — real copy comes from the brand voice guide.', 13)
on conflict (name) do nothing;

alter table leads add column if not exists qualification_override text; -- 'qualified' | 'not_yet' | 'needs_review' | null
alter table leads add column if not exists qualification_override_reason text;
alter table leads add column if not exists qualification_override_by text;
alter table leads add column if not exists qualification_override_at timestamptz;
