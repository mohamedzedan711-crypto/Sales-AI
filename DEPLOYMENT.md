# Deploying the Async Qualification Funnel + Voice Profile Backend

This covers everything beyond `index.html` — the pieces that need a real
Supabase project to run: the schema additions, the Edge Functions, the
scheduled jobs, and the questionnaire page's Supabase credentials.

**Deployment works with every provider key empty.** Anthropic, HubSpot,
Read.ai, and Fathom keys — plus the Gmail connection — are no longer set
via the CLI. They live in Settings → Integrations inside the app itself,
and each one goes live the moment it's saved there. No redeploy needed to
add, change, or remove one. The only things that still need to be true CLI
secrets are infrastructure-level (the Supabase service role, the admin
password gate, and the Gmail OAuth app's own client ID/secret — see why
below).

Read.ai and Fathom are independent and both optional — Fathom is being
introduced alongside Read.ai, not replacing it, per Mary's current setup.
`pull-transcripts` pulls from whichever one(s) are connected.

Everything in this build is best-effort based on Mary's VA briefing doc.
She's asked to screen-share her actual process before anything here is
final — treat the automations below (especially the qualification
thresholds and the meeting-prep brief content) as a starting point to
revise, not a finished spec.

Project: `https://cskenvvssmblqpbvtrig.supabase.co`

## 0. Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in (`supabase login`), linked to this project (`supabase link --project-ref cskenvvssmblqpbvtrig`).
- A Google Cloud OAuth app registered for Gmail API access (client ID + client secret) — this is a one-time infrastructure setup, separate from connecting an actual Gmail account, which now happens through the app's "Connect Gmail" button. Scopes to request: `gmail.send`, `gmail.readonly`, `userinfo.email`.

Anthropic, HubSpot, Read.ai, and Fathom accounts/keys are **not** needed at deploy time — add them later through the app.

## 1. Apply the schema

In the Supabase SQL editor (or via `supabase db push`), run in order: `supabase_schema.sql`, then `supabase_schema_v2.sql`, then `supabase_schema_v3.sql`, then `supabase_schema_v4.sql`, then `supabase_schema_v5.sql`, then `supabase_schema_v6.sql`. All six are safe to re-run (guarded with `IF NOT EXISTS` / `ON CONFLICT`).

`supabase_schema_v5.sql` adds `automation_failures`, used by the four unattended backend functions (`sync-hubspot-leads`, `pull-transcripts`, `check-booking-replies`, `qualify-lead`) to log anything they couldn't complete on their own. Surfaced in Settings → Integrations → Automation Activity — see the note under step 6 below.

`supabase_schema_v6.sql` adds a missing `business_name` column to `proposals` — without it, Save Proposal in Proposal Builder would fail against a connected Supabase project and silently fall back to browser-only storage, so saved proposals never appeared. If you already ran `supabase_schema.sql` before this fix, this migration is what makes Save Proposal actually persist.

`supabase_schema_v2.sql`'s `qualification_config` seed row now defaults to a $2,000 floor / $4,000 priority threshold — provisional numbers from Mary's brief, not confirmed with her directly yet. Both remain freely editable in Settings → Qualification Thresholds.

`supabase_schema_v4.sql` adds `meeting_prep_brief` / `meeting_prep_generated_at` to `leads`, used by the meeting-prep automation (step 7 below).

`supabase_schema_v3.sql` adds `api_credentials` and `oauth_states` — note that neither table gets an anon-access policy. That's intentional: the browser (and questionnaire.html) can never read or write these directly. Only Edge Functions running with the service-role key can, and even those go through an admin-password check for writes (see step 3).

## 2. Fill in the questionnaire page's Supabase credentials

Open `questionnaire.html` and replace the placeholder:

```js
const SUPABASE_ANON_KEY = 'FILL_IN_YOUR_SUPABASE_ANON_KEY';
```

with your project's actual anon/public key (Project Settings → API in the Supabase dashboard). This is safe to embed client-side — Row Level Security on `questionnaire_responses` restricts it to insert-only, so it can't read or modify anything else (and, per step 1, it has zero access to `api_credentials`).

Deploy `questionnaire.html` alongside `index.html` on whatever static host you're using (same repo, same deploy).

## 3. Set the infrastructure secrets (this is now the whole list)

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — don't set those. Everything else that remains a true secret:

```bash
supabase secrets set GMAIL_CLIENT_ID=...
supabase secrets set GMAIL_CLIENT_SECRET=...
supabase secrets set ADMIN_PANEL_PASSWORD=choose-a-strong-password
supabase secrets set QUESTIONNAIRE_BASE_URL=https://yourdomain.com
```

- `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` identify the OAuth *app* itself (must match what's registered in Google Cloud Console, redirect URI and all) — not a per-user credential, so it can't reasonably be entered through a form. This is the one exception to "everything's in the app now."
- `ADMIN_PANEL_PASSWORD` gates every write to `api_credentials` (saving/testing a key, disconnecting one, starting the Gmail OAuth flow). There's no login system in this app otherwise — whoever knows this password can manage integrations from Settings → Integrations. Treat it like any other secret; don't share it outside the team that manages this deployment.
- `QUESTIONNAIRE_BASE_URL` is wherever `index.html`/`questionnaire.html` are actually reachable (no trailing slash) — used to build the questionnaire link in emails, and to redirect the browser back after the Gmail OAuth flow completes.

### Register the Gmail OAuth redirect URI

In Google Cloud Console, under the OAuth client's **Authorized redirect URIs**, add exactly:

```
https://cskenvvssmblqpbvtrig.supabase.co/functions/v1/gmail-oauth-callback
```

This has to match byte-for-byte or Google will reject the callback.

## 4. Deploy the functions

```bash
supabase functions deploy sync-hubspot-leads
supabase functions deploy qualify-lead
supabase functions deploy send-booking-email
supabase functions deploy pull-transcripts
supabase functions deploy check-booking-replies
supabase functions deploy save-credential
supabase functions deploy get-credentials-status
supabase functions deploy disconnect-credential
supabase functions deploy gmail-oauth-start
supabase functions deploy gmail-oauth-callback
supabase functions deploy generate-meeting-brief
```

`send-booking-email` is called directly from the app (with the anon key) when Mary clicks "Confirm & Send" in the Book Meeting modal — it also generates the meeting-prep brief automatically right after booking. `generate-meeting-brief` is called directly from the app when a meeting is booked through the manual "Book Call" button instead (both paths share the same logic in `_shared/meetingPrep.ts`). `save-credential`, `disconnect-credential`, and `gmail-oauth-start` are called directly from Settings → Integrations (admin-password gated). `get-credentials-status` is called from Settings to render the connection badges (read-only, no admin gate — it never returns key values). `gmail-oauth-callback` is only ever called by Google's redirect, never directly.

`pull-transcripts` now does two things per transcript, both best-effort and independent of each other: appends it to the lead's `comm_log` (as before), and — if HubSpot + Anthropic are both connected and the lead has a `hubspot_contact_id` on file — has Claude extract structured call info (summary, key details, next steps, budget/timeline signals) and pushes it into HubSpot as a note on the contact. This is Mary's stated #1 priority automation. A missing HubSpot connection or a HubSpot API error on the note push never blocks the underlying transcript append.

## 5. Wire the questionnaire-response webhook

In the Supabase Dashboard: **Database → Webhooks → Create a new webhook**
- Table: `questionnaire_responses`
- Events: `INSERT`
- Type: HTTP Request → your `qualify-lead` function URL (`https://cskenvvssmblqpbvtrig.supabase.co/functions/v1/qualify-lead`)
- Header: `Authorization: Bearer <service_role_key>` (Database Webhooks send with the service role by default in recent Supabase versions — confirm this is set so the function can read `leads` regardless of RLS)

## 6. Schedule the recurring functions (pg_cron)

Run in the SQL editor (requires the `pg_cron` and `pg_net` extensions, enabled by default on most Supabase projects — enable them under Database → Extensions if not):

```sql
select cron.schedule(
  'sync-hubspot-leads-every-15-min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://cskenvvssmblqpbvtrig.supabase.co/functions/v1/sync-hubspot-leads',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'))
  );
  $$
);

select cron.schedule(
  'pull-transcripts-every-30-min',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := 'https://cskenvvssmblqpbvtrig.supabase.co/functions/v1/pull-transcripts',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'))
  );
  $$
);

select cron.schedule(
  'check-booking-replies-every-15-min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://cskenvvssmblqpbvtrig.supabase.co/functions/v1/check-booking-replies',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'))
  );
  $$
);
```

If `current_setting('app.settings.service_role_key')` isn't populated in your project, paste the service role key directly into the header instead (Project Settings → API → service_role key) — treat it the same as any other secret. Note these scheduled functions will fail gracefully (clear "not connected" error) until the corresponding keys are added through the app — that's expected until step 7 below is done. Since a cron-invoked function's response is never read by anyone, that failure (and any other issue one of these functions hits mid-run, like a transcript it couldn't match to a lead or a HubSpot note push that failed) is also written to `automation_failures` and shown in Settings → Integrations → **Automation Activity**, so it's never just sitting in the function logs unnoticed.

Monday.com has no Edge Function or cron entry — it's a client-side-only connection (Settings → CRM → Monday.com API Key, same pattern as the old Instagram/Facebook/LinkedIn keys before those existed as real integrations), used by the manual "Sync Monday" button in the Sales Pipeline tab. Mary currently runs both HubSpot and Monday.com and knows they're duplicated; consolidating onto HubSpot alone is still an open decision, not settled — this build keeps both trackable without forcing that choice.

## 7. In the app itself

- Settings → Database: connect Supabase (URL + anon key), enable it.
- Settings → Integrations: enter the `ADMIN_PANEL_PASSWORD` you set in step 3, then add the Anthropic, HubSpot, Read.ai, and/or Fathom keys one at a time — each is live-tested on save, so a bad key shows "Invalid Key" instead of silently failing later. Read.ai and Fathom are both optional and independent; connect either or both. Click "Connect Gmail" and complete the Google consent screen; it'll redirect back here and show the connected account's email.
- Settings → Qualification Thresholds: pre-filled with $2,000 floor / $4,000 priority from Mary's brief — confirm these are right with her directly (they came from the VA briefing doc, not from Mary in person) and adjust before relying on the qualification scoring.
- Settings → Mary's Voice Profile: paste real email samples, click Generate, review, Save.

Note: the existing Settings fields for Anthropic/HubSpot/Read.ai elsewhere on the page (under AI, CRM, Calls & Proposals) are separate from Integrations — those power this app's own in-browser features (drafting emails, the manual HubSpot sync button, etc.) and are unrelated to the backend automation. You'll likely want the same key in both places, but they're independent by design.

## Known gaps to confirm once you have real API access

- **Read.ai**: `pull-transcripts`'s endpoint (`api.read.ai/v1/sessions`) and field names (`session.attendees`, `session.transcript`, etc.) are a best-effort guess at a reasonable REST shape — adjust once you can see Read.ai's actual API docs or a sample response. The same guessed endpoint is used for the Read.ai key test in `save-credential`.
- **Fathom**: same caveat, applied to `https://api.fathom.video/v1/calls` and fields like `call.invitees`/`call.transcript` in `fetchFathomCalls` (in `pull-transcripts`) — adjust once you have real Fathom API access.
- **HubSpot note-to-deal association**: `createHubspotNote` (in `_shared/hubspot.ts`) uses `associationTypeId: 214` for note-to-deal, which is HubSpot's documented default but not independently verified against a live account. The note-to-contact association (`202`) came from HubSpot's docs via earlier work in this app and is trusted. If deal association silently doesn't show up in HubSpot, the note itself still lands on the contact — that part degrades gracefully.
- **Proposal deck automation (4 custom pages)**: intentionally not built yet — needs Mary's actual template structure, which wasn't available for this round. The existing Proposal Builder (generic proposal generation) is unchanged.

## Lead sources

HubSpot is the single lead-entry point. `sync-hubspot-leads` is the sole automated path new leads enter the pipeline — ad platforms (Facebook, Instagram, Google, LinkedIn) feed HubSpot directly on HubSpot's side, so every synced lead is simply tagged `source: 'HubSpot'`. Manual lead entry ("+ Add Lead" in the Sales Pipeline tab, including the paste-and-extract-with-Claude flow) remains available as a fallback for leads that aren't in HubSpot yet — those can be tagged Referral, Website, Cold Outreach, or Other.

DM Manager (Instagram/Facebook/LinkedIn) is back, but it's not a lead source — it's a paste-in/draft-reply tool for DMs, the same job as Inbox Manager but for DMs instead of email. It never writes to `leads`.
