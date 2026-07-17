# Social Practice AI — Sales Engine
Built by Zane Zedan | Goldbar Certified EA
AI-powered sales operations system for Social Practice / Mary Robb

## Setup
1. Open index.html via local server
2. Go to Settings and add API keys
3. All data saves to localStorage by default
4. Connect Supabase for live deployment

## Connections Available
- Claude AI (Anthropic)
- HubSpot
- Monday.com (tracked alongside HubSpot — consolidating onto HubSpot alone is still an open decision Mary hasn't made yet)
- Gmail
- Read.ai and Fathom (independent, both optional — Fathom is being introduced alongside Read.ai, not replacing it)
- Otter.ai
- Prospero
- Supabase

DM Manager (Instagram/Facebook/LinkedIn) works via paste-in, same as Inbox Manager — no API keys or "connections" involved. It drafts replies in Mary's voice; it is not a lead source. Leads only ever enter the pipeline through HubSpot.

## Async Qualification Funnel + Voice Profile Backend
`index.html` and `questionnaire.html` are the frontend. The automation that
sends questionnaire links, scores leads, sends booking emails, pulls call
transcripts, and watches for reschedule replies runs as Supabase Edge
Functions in `supabase/functions/*` — see [DEPLOYMENT.md](DEPLOYMENT.md) for
the full setup (schema, secrets, deploy commands, cron schedule, webhook
wiring). Nothing in that folder runs on its own until it's deployed.
