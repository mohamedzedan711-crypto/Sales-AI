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
- Gmail
- Instagram / Facebook / LinkedIn
- Read.ai
- Otter.ai
- Prospero
- Supabase

## Async Qualification Funnel + Voice Profile Backend
`index.html` and `questionnaire.html` are the frontend. The automation that
sends questionnaire links, scores leads, sends booking emails, pulls call
transcripts, and watches for reschedule replies runs as Supabase Edge
Functions in `supabase/functions/*` — see [DEPLOYMENT.md](DEPLOYMENT.md) for
the full setup (schema, secrets, deploy commands, cron schedule, webhook
wiring). Nothing in that folder runs on its own until it's deployed.
