# Social Practice Sales Engine
Built by Zane Zedan | Goldbar Certified EA
Sales operations system for Social Practice / Mary Robb

This is a purely deterministic automation system — no LLM/AI calls anywhere,
frontend or backend. HubSpot is the system of record; HubSpot Workflows send
lead emails natively. This repo's backend automation (scoring, syncing,
transcript logging, booking emails, meeting-prep briefs) is entirely
rule-based and template-driven.

Every automatic send the backend can trigger (questionnaire emails, booking
confirmations, the HubSpot note push after a call transcript) is gated by a
single kill switch — Settings → "Auto-Send / Auto-Respond", stored in
Supabase, defaults to OFF. Nothing sends on its own until that's turned on.
Changing it requires the same admin password as Settings → Integrations —
the switch can't be flipped directly from the browser; it only goes through
an admin-password-gated Edge Function.

## Setup
1. Open index.html via local server
2. Go to Settings and add API keys
3. All data saves to localStorage by default
4. Connect Supabase for live deployment

## Connections Available
- HubSpot — the sole system of record for leads; HubSpot Workflows send lead emails natively
- Gmail
- Read.ai — the sole call-transcript source (Fathom support was removed entirely, backend and frontend)
- Prospero
- Supabase

## Async Qualification Funnel + Meeting-Prep Backend
`index.html` and `questionnaire.html` are the frontend. The automation that
sends questionnaire links, scores leads, sends booking emails, pulls call
transcripts, and watches for reschedule replies runs as Supabase Edge
Functions in `supabase/functions/*` — see [DEPLOYMENT.md](DEPLOYMENT.md) for
the full setup (schema, secrets, deploy commands, cron schedule, webhook
wiring, and the auto-send kill switch). Nothing in that folder runs on its
own until it's deployed. Every email this backend sends uses a static
template, lead scoring/reply classification are rule-based, and the
meeting-prep brief is a templated document built from data already in the
system — see DEPLOYMENT.md for specifics.
