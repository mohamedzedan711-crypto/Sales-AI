-- ============================================================
-- Social Practice AI — Schema v6
-- Fixes "Save Proposal" silently not persisting: the client has always
-- inserted a business_name on every proposal row (Proposal Builder
-- supports proposals not tied to an existing lead, so it can't rely on
-- leads.business_name via the lead_id join alone), but the original
-- schema never had that column. Against a connected Supabase project the
-- insert was rejected outright (unknown column), the client silently fell
-- back to localStorage-only, and the next read hit Supabase successfully
-- (just empty) instead of falling back — so the save looked like a no-op.
-- Run this AFTER v1/v2/v3/v4/v5. Safe to re-run (IF NOT EXISTS guard).
-- ============================================================

alter table proposals add column if not exists business_name text;
