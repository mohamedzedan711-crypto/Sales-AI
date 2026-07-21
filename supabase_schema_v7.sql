-- ============================================================
-- Social Practice AI — Schema v7
-- Adds duplicate_flag (soft-duplicate advisory pointer, see saveNewLead()
-- in index.html and the inverse-match check in sync-hubspot-leads) and
-- signed_snapshot (frozen record of a lead's terms at the moment it was
-- first marked Signed, see changeLeadStage() in index.html — never
-- overwritten after the first capture). Run this AFTER v1-v6.
-- Safe to re-run (IF NOT EXISTS guards).
-- ============================================================

alter table leads add column if not exists duplicate_flag uuid references leads(id);
alter table leads add column if not exists signed_snapshot jsonb;
