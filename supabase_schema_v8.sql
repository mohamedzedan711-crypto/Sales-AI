-- ============================================================
-- Social Practice AI — Schema v8
-- Adds system_settings: a singleton row holding the global auto-send
-- kill switch. Every backend function that sends or triggers an automatic
-- send (send-questionnaire-email, sync-hubspot-leads, send-booking-email,
-- send-lead-email, and pull-transcripts' HubSpot note push) checks
-- auto_send_enabled first and skips (logging to automation_failures)
-- instead of sending when it's false. Defaults to false — auto-send stays
-- OFF until someone turns it on from Settings. Run this AFTER v1-v7.
-- Safe to re-run (IF NOT EXISTS / ON CONFLICT guards).
-- ============================================================

create table if not exists system_settings (
  id int primary key default 1 check (id = 1),
  auto_send_enabled boolean not null default false,
  updated_at timestamptz default now()
);
insert into system_settings (id, auto_send_enabled) values (1, false) on conflict (id) do nothing;

alter table system_settings enable row level security;
create policy "allow all" on system_settings for all using (true);
