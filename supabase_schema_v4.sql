-- ============================================================
-- Social Practice AI — Schema v4
-- Adds columns for the meeting-prep brief automation (structured-only —
-- built from questionnaire answers + pipeline data already in the system,
-- no external web/social research). Run this AFTER v1/v2/v3.
-- Safe to re-run (IF NOT EXISTS guards).
-- ============================================================

alter table leads add column if not exists meeting_prep_brief text;
alter table leads add column if not exists meeting_prep_generated_at timestamptz;
