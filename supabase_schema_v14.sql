-- ============================================================
-- Social Practice AI — Schema v14
-- Settings Sidebar + Templates Manager + Link Library + Form-Submission
-- History build. Adds:
--
-- 1. app_links: a tiny global (not per-lead) key/value store for the two
--    reusable URLs the new Templates editor can insert as hyperlinks —
--    Qualification Form and Booking Meeting. RLS is deliberately open
--    ("allow all"), matching the precedent already set by `templates`
--    (schema v12): there's nothing sensitive in two org-wide marketing
--    URLs, and the frontend reads/writes this directly with the anon
--    key, same as `templates`/`qualification_config`. Seeded with both
--    keys present and a null value — the Forms & Links settings page is
--    where Zane/Mary actually paste the real URLs in.
--
-- 2. leads.last_qualification_form_submission_at: lets
--    hubspot-webhook-receiver tell "a new Discovery Qualification Form
--    submission just came in" apart from "this contact's
--    recent_conversion_event_name still says Discovery Qualification
--    Form because that's still the most recent thing they ever
--    submitted, and some unrelated property just changed" — without
--    this, every subsequent HubSpot property-change event for that
--    contact would re-log the same submission to comm_log forever.
--    Nullable; null means no submission has been logged yet.
--
-- Safe to re-run (IF NOT EXISTS / ON CONFLICT guards; policy dropped and
-- recreated rather than using "IF NOT EXISTS", which CREATE POLICY
-- doesn't support in Postgres).
-- ============================================================

create table if not exists app_links (
  key text primary key,
  label text not null,
  value text,
  updated_at timestamptz default now()
);
alter table app_links enable row level security;
drop policy if exists "allow all" on app_links;
create policy "allow all" on app_links for all using (true);

insert into app_links (key, label, value) values
  ('qualification_form', 'Qualification Form', null),
  ('booking_meeting', 'Booking Meeting', null)
on conflict (key) do nothing;

alter table leads add column if not exists last_qualification_form_submission_at timestamptz;
