# Deploying the Async Qualification Funnel Backend

This covers everything beyond `index.html` — the pieces that need a real
Supabase project to run: the schema additions, the Edge Functions, the
scheduled jobs, and the questionnaire page's Supabase credentials.

**Deployment works with every provider key empty.** HubSpot and Read.ai
keys — plus the Gmail connection — are no longer set via the CLI. They
live in Settings → Integrations inside the app itself,
and each one goes live the moment it's saved there. No redeploy needed to
add, change, or remove one. The only things that still need to be true CLI
secrets are infrastructure-level (the Supabase service role, the admin
password gate, and the Gmail OAuth app's own client ID/secret — see why
below).

Read.ai is the sole call-transcript source. Fathom support was removed
entirely — no credential lookup, no fetch, no code path anywhere in
`pull-transcripts` or the shared credential helpers.

Everything in this build is best-effort based on Mary's VA briefing doc.
She's asked to screen-share her actual process before anything here is
final — treat the automations below (especially the qualification
thresholds and the meeting-prep brief content) as a starting point to
revise, not a finished spec.

Project: `https://cskenvvssmblqpbvtrig.supabase.co`

## 0. Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in (`supabase login`), linked to this project (`supabase link --project-ref cskenvvssmblqpbvtrig`).
- A Google Cloud OAuth app registered for Gmail API access (client ID + client secret) — this is a one-time infrastructure setup, separate from connecting an actual Gmail account, which now happens through the app's "Connect Gmail" button. Scopes to request: `gmail.send`, `gmail.readonly`, `userinfo.email`.

HubSpot and Read.ai accounts/keys are **not** needed at deploy time — add them later through the app.

## 1. Apply the schema

In the Supabase SQL editor (or via `supabase db push`), run in order: `supabase_schema.sql`, then `supabase_schema_v2.sql`, then `supabase_schema_v3.sql`, then `supabase_schema_v4.sql`, then `supabase_schema_v5.sql`, then `supabase_schema_v6.sql`, then `supabase_schema_v7.sql`, then `supabase_schema_v8.sql`, then `supabase_schema_v9.sql`, then `supabase_schema_v10.sql`, then `supabase_schema_v11.sql`, then `supabase_schema_v12.sql`, then `supabase_schema_v13.sql`. All are safe to re-run (guarded with `IF NOT EXISTS` / `ON CONFLICT`, or a `drop policy if exists` for v9/v12; v13's two `UPDATE`s are naturally idempotent).

`supabase_schema_v13.sql` is a **data-only migration for the Lead Board Redesign** — no schema changes, just `UPDATE leads SET stage = 'Closed Won' WHERE stage = 'Signed'` and the equivalent for `'Lost'` → `'Closed Lost'`. This exists because the new Kanban board's 9 columns (New Lead, Contacted, Discovery Booked, Discovery Done, Proposal Sent, Agreement Sent, Nurturing, Closed Won, Closed Lost) renamed two of the app's stage strings. Every other existing stage value is unchanged; `Contacted` is new and starts empty (leads only reach it by being dragged there); `Discovery Done` isn't one of the redesign's 8 named columns but was kept as a 9th rather than silently reassigning those leads. **Run this only after deploying the matching `index.html`** — the old build still writes/reads `'Signed'`/`'Lost'`, so running v13 against the old frontend would make its Signed/Lost filtering and stat cards silently stop matching any lead.

`supabase_schema_v11.sql` adds `hubspot_sync_state` — a singleton cursor row used by `sync-hubspot-contacts` (a second, independent HubSpot→leads sync path; see step 4).

`supabase_schema_v12.sql` is the schema for the "Manual Send + Automated Detection" build: `companies` (new table, FK'd from `leads.company_id`), `deals` (FK'd to both `leads` and `companies`, tracks both a HubSpot deal id and a Prospero deal id), `prospero_events` (logs every raw Prospero webhook payload verbatim, before any parsing — see step 8), `templates` (the canned-message library Mary sends from; seeded with 16 placeholder rows across `qualification`/`lead_gen`/`follow_up`/`booking` — actual copy still needs to be filled in from the brand-voice guide, not done in this pass), and four `qualification_override*` columns on `leads` (a human override sitting *alongside* the deterministic qualification score/reason, never replacing them — both stay visible).

`supabase_schema_v10.sql` is a **scaffold, not a working integration** — it adds `read_ai_tokens` (token storage for a planned Read.ai OAuth 2.1 connection) and a nullable `code_verifier` column on `oauth_states` (for that flow's PKCE requirement). Read.ai OAuth client_id/client_secret don't exist yet — `read-ai-authorize` and `read-ai-oauth-callback` (deployed in step 4) will throw a clear "not configured" error until `READ_AI_CLIENT_ID`/`READ_AI_CLIENT_SECRET`/`READ_AI_AUTH_URL`/`READ_AI_TOKEN_URL`/`READ_AI_REDIRECT_URI` are set as real Supabase secrets (see `.env.example`). This is entirely separate from the existing Read.ai integration (the plain API key in Settings → Integrations, used by `pull-transcripts`) — that one is untouched.

`supabase_schema_v8.sql` adds `system_settings` — a single row holding the global auto-send kill switch (`auto_send_enabled`, defaults to `false`). Every function that sends or triggers an automatic send (`send-questionnaire-email`, `sync-hubspot-leads`, `send-booking-email`, `send-lead-email`, and `pull-transcripts`' HubSpot note push) checks this first and skips (logging to `automation_failures`) instead of sending while it's off.

`supabase_schema_v9.sql` locks `system_settings` down to anon-read-only, replacing v8's permissive policy. The switch can only be changed through the new `set-auto-send` Edge Function (admin-password gated, deployed in step 4) — a direct Supabase client call from the browser can no longer flip it, only read the current state. Toggle it from Settings → "Auto-Send / Auto-Respond" — enter the `ADMIN_PANEL_PASSWORD` in Settings → Integrations first (same password, shared by both). It starts OFF and stays OFF until turned on there.

`supabase_schema_v5.sql` adds `automation_failures`, used by the unattended backend functions (`sync-hubspot-leads`, `pull-transcripts`, `check-booking-replies`, `qualify-lead`, `send-questionnaire-email`) to log anything they couldn't complete on their own. Surfaced in Settings → Integrations → Automation Activity — see the note under step 6 below.

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

`index.html` now embeds the same project URL and anon key as `DEFAULT_SUPABASE_URL` / `DEFAULT_SUPABASE_ANON_KEY` (near `initSupabase()`), for the same reason and with the same safety guarantee — RLS is the real boundary, not secrecy of the anon key. This means the app auto-connects to Supabase on any origin (file://, localhost, a new deploy URL) with zero manual setup; Settings → Database still accepts a different URL/key to override it (e.g. pointing a local build at a separate test project). **If you ever point this deployment at a different Supabase project, update both `DEFAULT_SUPABASE_URL`/`DEFAULT_SUPABASE_ANON_KEY` in `index.html` and `SUPABASE_URL`/`SUPABASE_ANON_KEY` in `questionnaire.html` to match — they're independent constants, not shared from one file.**

Deploy `questionnaire.html` alongside `index.html` on whatever static host you're using (same repo, same deploy).

## 3. Set the infrastructure secrets (this is now the whole list)

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — don't set those. Everything else that remains a true secret:

```bash
supabase secrets set GMAIL_CLIENT_ID=...
supabase secrets set GMAIL_CLIENT_SECRET=...
supabase secrets set ADMIN_PANEL_PASSWORD=choose-a-strong-password
supabase secrets set QUESTIONNAIRE_BASE_URL=https://yourdomain.com
supabase secrets set HUBSPOT_CLIENT_SECRET=...
```

- `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` identify the OAuth *app* itself (must match what's registered in Google Cloud Console, redirect URI and all) — not a per-user credential, so it can't reasonably be entered through a form. This is the one exception to "everything's in the app now."
- `ADMIN_PANEL_PASSWORD` gates every write to `api_credentials` (saving/testing a key, disconnecting one, starting the Gmail OAuth flow) *and* the auto-send kill switch (`set-auto-send`). There's no login system in this app otherwise — whoever knows this password can manage integrations and turn automatic sending on or off from Settings. Treat it like any other secret; don't share it outside the team that manages this deployment.
- `QUESTIONNAIRE_BASE_URL` is wherever `index.html`/`questionnaire.html` are actually reachable (no trailing slash) — used to build the questionnaire link in emails, and to redirect the browser back after the Gmail OAuth flow completes.
- `HUBSPOT_CLIENT_SECRET` is a **different credential from `HUBSPOT_API_KEY`** — it belongs to a HubSpot *App* (not a private-app API key) and is what `hubspot-webhook-receiver` uses to verify HubSpot's v3 webhook signature on every incoming request. It does not exist until you register that App (see step 8). Until this secret is set, `hubspot-webhook-receiver` rejects every request with a clear, logged "not configured" reason — it fails closed, not open.

**Not yet a real secret to set** — the Read.ai OAuth 2.1 scaffold (`read-ai-authorize` / `read-ai-oauth-callback` / `_shared/readAiClient.ts`) needs `READ_AI_CLIENT_ID`, `READ_AI_CLIENT_SECRET`, `READ_AI_AUTH_URL`, `READ_AI_TOKEN_URL`, `READ_AI_REDIRECT_URI`, and `READ_AI_API_BASE_URL` (see `.env.example`), but none of those exist yet since there's no registered Read.ai OAuth app. Nothing in this scaffold runs until they're set.

### Register the Gmail OAuth redirect URI

In Google Cloud Console, under the OAuth client's **Authorized redirect URIs**, add exactly:

```
https://cskenvvssmblqpbvtrig.supabase.co/functions/v1/gmail-oauth-callback
```

This has to match byte-for-byte or Google will reject the callback.

### Read.ai OAuth redirect URI (once a Read.ai OAuth app exists)

Not usable yet — there's no Read.ai OAuth app to register this with. For when one exists, the redirect URI this scaffold's callback expects (and what `READ_AI_REDIRECT_URI` should be set to) is:

```
https://cskenvvssmblqpbvtrig.supabase.co/functions/v1/read-ai-oauth-callback
```

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
supabase functions deploy check-integration-status
supabase functions deploy send-questionnaire-email
supabase functions deploy send-lead-email
supabase functions deploy set-auto-send
supabase functions deploy read-ai-authorize
supabase functions deploy read-ai-oauth-callback
supabase functions deploy sync-hubspot-contacts
supabase functions deploy hubspot-webhook-receiver
supabase functions deploy prospero-webhook-receiver
supabase functions deploy send-template
```

`sync-hubspot-contacts` is a second, independent HubSpot→leads sync (incremental, cursor-based via `hubspot_sync_state`) — separate from `sync-hubspot-leads` above, which stays as-is. Not yet deployed as of this writing; review before deploying.

`hubspot-webhook-receiver` and `prospero-webhook-receiver` are new — see step 8 for the exact webhook setup (this is the part that happens in each provider's own UI, not in code). `send-template` is called directly from the app (with the anon key) when Mary clicks Send after previewing a template in the new Templates picker on a lead's detail row — see step 9.

### Optional: skip pasting keys into Settings entirely

Either of the two backend keys (`HUBSPOT_API_KEY`, `READAI_API_KEY`) can instead be set as a plain Supabase secret:

```bash
supabase secrets set HUBSPOT_API_KEY=...
```

`_shared/credentials.ts`'s `getCredential()` checks `api_credentials` (Settings → Integrations) first and falls back to the matching env var if nothing's connected there — so a key set this way works immediately in every backend function, from every origin the app is opened from (file://, localhost, the live URL), with no re-pasting and no admin password needed. Settings → Integrations and Settings → Connection Status both show "Connected — Supabase secret" for these via the new `check-integration-status` function. Pasting a key into Settings still overrides the secret (useful for quick local testing with a different key).

Because `getCredential()` lives in `_shared/credentials.ts`, this fallback only takes effect in functions that are redeployed after this change — that's every function in the list above except `gmail-oauth-callback` (which doesn't import credentials.ts).

**Nothing in this system calls an LLM, frontend or backend.** `qualify-lead` scores leads with plain threshold rules, `check-booking-replies` classifies Gmail replies with keyword matching, `pull-transcripts` pushes the raw transcript text to HubSpot (no summarization), `send-questionnaire-email`/`send-booking-email`/`sync-hubspot-leads` send static-template emails, and the meeting-prep brief (`generate-meeting-brief`, and the inline call inside `send-booking-email`, both via `_shared/meetingPrep.ts`) is a templated document built from the lead's qualification data, communications timeline, and — if available — Read.ai's own summary/action items for that lead's meeting. The frontend's former AI features (Proposal Builder, Call Notes, Mary's Voice Profile, lead-paste extraction, the cross-tab AI chat widget, and the Nurture/Recap/Reactivate/Book-Call draft modal's auto-drafting) have all been removed; the draft modal is now a manual textarea — the user writes the message themselves, same Copy/Send buttons as before. DM Manager, Inbox Manager's drafting, and the Follow-Up Tracker's drafting were removed in an earlier pass; "Mark as Sent" on the Follow-Up Tracker is a direct bookkeeping action with no drafting or send involved.

Every automatic send below (webhook-, cron-, or button-triggered) is gated by the auto-send kill switch — see the `supabase_schema_v8.sql` note under step 1 and Settings → "Auto-Send / Auto-Respond" under step 7. It defaults to OFF.

`send-lead-email` is called directly from the app (with the anon key), like `send-booking-email` — not webhook-triggered, so it needs no Database Webhook. It fires when the "Send" button is clicked in the Nurture/Recap/Reactivate draft modal or the manual "Book Call" confirmation email — it sends whatever the user typed in the textarea as-is, no drafting of its own.

`send-booking-email` is called directly from the app (with the anon key) when Mary clicks "Confirm & Send" in the Book Meeting modal — it also generates the meeting-prep brief automatically right after booking. `generate-meeting-brief` is called directly from the app when a meeting is booked through the manual "Book Call" button instead (both paths share the same logic in `_shared/meetingPrep.ts`). `save-credential`, `disconnect-credential`, and `gmail-oauth-start` are called directly from Settings → Integrations (admin-password gated). `get-credentials-status` is called from Settings to render the connection badges (read-only, no admin gate — it never returns key values). `gmail-oauth-callback` is only ever called by Google's redirect, never directly.

`pull-transcripts` now does two things per transcript, both best-effort and independent of each other: appends it to the lead's `comm_log` (as before), and — if HubSpot is connected and the lead has a `hubspot_contact_id` on file — pushes the raw transcript text (truncated to a safe length) into HubSpot as a note on the contact. This is Mary's stated #1 priority automation. As of the deterministic-automation redesign this is no longer an AI-summarized note — no LLM is involved in this path at all. A missing HubSpot connection or a HubSpot API error on the note push never blocks the underlying transcript append.

## 5. Wire the questionnaire-response webhook

In the Supabase Dashboard: **Database → Webhooks → Create a new webhook**
- Table: `questionnaire_responses`
- Events: `INSERT`
- Type: HTTP Request → your `qualify-lead` function URL (`https://cskenvvssmblqpbvtrig.supabase.co/functions/v1/qualify-lead`)
- Header: `Authorization: Bearer <service_role_key>` (Database Webhooks send with the service role by default in recent Supabase versions — confirm this is set so the function can read `leads` regardless of RLS)

## 5b. Wire the new-lead webhook

Same pattern, one table over — this is what makes `send-questionnaire-email` fire automatically the moment a lead row is created, no button anywhere in the app:

In the Supabase Dashboard: **Database → Webhooks → Create a new webhook**
- Table: `leads`
- Events: `INSERT`
- Type: HTTP Request → your `send-questionnaire-email` function URL (`https://cskenvvssmblqpbvtrig.supabase.co/functions/v1/send-questionnaire-email`)
- Header: `Authorization: Bearer <service_role_key>`

`send-questionnaire-email` skips (without treating it as a failure) any row that already arrives with `questionnaire_sent_at` set — that's `sync-hubspot-leads`, which sets it itself and sends its own questionnaire email inline at insert time. This webhook is effectively what sends the questionnaire link for every other way a lead gets created, chiefly manual "+ Add Lead" in the Sales Pipeline tab, which never sets that field.

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

## 7. In the app itself

- Settings → Database: connect Supabase (URL + anon key), enable it.
- Settings → Integrations: enter the `ADMIN_PANEL_PASSWORD` you set in step 3 first — it's required for everything below, including the kill switch. Then add the HubSpot and/or Read.ai keys — each is live-tested on save, so a bad key shows "Invalid Key" instead of silently failing later. Click "Connect Gmail" and complete the Google consent screen; it'll redirect back here and show the connected account's email.
- Settings → "Auto-Send / Auto-Respond": stays OFF until you deliberately turn it on — and the toggle rejects the change until the admin password above has been entered, same as saving or disconnecting a key. Every automatic send (questionnaire emails, booking confirmations, the HubSpot note push after a transcript) is skipped and logged to Automation Activity while it's off — flip it on only once everything else here is connected and verified.
- Settings → Qualification Thresholds: pre-filled with $2,000 floor / $4,000 priority from Mary's brief — confirm these are right with her directly (they came from the VA briefing doc, not from Mary in person) and adjust before relying on the qualification scoring.

Note: the existing Settings field for HubSpot elsewhere on the page (under CRM) is separate from Integrations — it powers this app's own in-browser features (the manual HubSpot sync button, HubSpot logging from the draft modal, etc.) and is unrelated to the backend automation. You'll likely want the same key in both places, but they're independent by design.

## 8. HubSpot & Prospero webhooks (detection layer)

This is the "Manual Send + Automated Detection" build: HubSpot and Prospero stay fully automated on the *detection* side (their data flows into `leads`/`companies`/`deals` the instant something changes, no polling, no pg_cron — pg_cron is not available on this Supabase project anyway). The *outreach* side (actually emailing someone) stays manual — see step 9. Neither webhook receiver ever sends an email or triggers a HubSpot Workflow; they only detect and upsert.

### 8a. HubSpot webhook subscriptions (done in HubSpot's UI, not in code)

HubSpot's v3 webhook signature requires a HubSpot **App** with a Client Secret — this is different from the `HUBSPOT_API_KEY` private-app token already in use everywhere else in this codebase. If you don't already have a HubSpot App registered for this project:

1. In HubSpot: **Settings → Integrations → Private Apps** won't work here — webhooks need a full **App** (Settings → Integrations → Apps, or developer.hubspot.com → "Create app"). Create one (or use an existing one) scoped to this account.
2. Under that App's **Webhooks** tab, set the **Target URL** to:
   ```
   https://cskenvvssmblqpbvtrig.supabase.co/functions/v1/hubspot-webhook-receiver
   ```
3. Add these four subscriptions:
   - `contact.creation`
   - `contact.propertyChange`
   - `company.creation`
   - `company.propertyChange`
4. Copy the App's **Client Secret** (on the App's Auth tab) and set it as the `HUBSPOT_CLIENT_SECRET` Supabase secret (step 3 above) — this is what the receiver uses to verify `X-HubSpot-Signature-v3` on every request.
5. Install/activate the App on the HubSpot account so the subscriptions actually start firing.

This has **not been tested against a live HubSpot App** — the signature algorithm (`_shared/hubspotWebhookAuth.ts`) is implemented per HubSpot's documented v3 spec (`base64(HMAC-SHA256(method + URI + body + timestamp, clientSecret))`), but exact-URI matching is the most common real-world cause of signature mismatches, so confirm the first real delivery succeeds before relying on this.

Existing HubSpot Workflows (including "Hire Us Form Submission Workflow") are untouched by any of this and keep running exactly as they do today — this receiver only reads HubSpot data into Sales-AI, it never writes anything that could trigger a HubSpot Workflow.

### 8b. Prospero webhook

Prospero has no API — it's webhook-only, so Sales-AI has to be the one giving Prospero a URL to call, not the other way around. In Prospero's settings, wherever it lets you configure an outgoing webhook/integration URL, set it to:

```
https://cskenvvssmblqpbvtrig.supabase.co/functions/v1/prospero-webhook-receiver
```

No signing secret or auth header is required on Prospero's side — every payload received is logged verbatim to `prospero_events` first, before any parsing is attempted, specifically because **the real shape of a Prospero payload has not been seen yet**. Field extraction (`extractDealFields` in `prospero-webhook-receiver/index.ts`) is a best-effort guess across several plausible key names and nesting levels — treat it as a starting point, not a finished mapping, and revisit it against `prospero_events.raw_payload` once real deliveries start arriving.

Matching a Prospero event to a lead: exact email match first (no HubSpot call needed), then — if no email match and a company name was extracted — a `CONTAINS_TOKEN` fuzzy search against HubSpot's Company `name` property (built fresh for this pass; there was no prior "Monday migration" implementation of this anywhere in the codebase to reuse). If neither resolves to exactly one lead, the event is left unprocessed (logged, not guessed) rather than attached to the wrong record.

Sales-AI is the middleware between the two systems: a matched Prospero event is upserted into Sales-AI's own `deals` table *and* pushed to HubSpot as a Deal — Prospero and HubSpot never talk to each other directly.

As of the Lead Board Redesign, a matched lead's `source` column is also set to `'Prospero'` — but only when it's currently blank. This never overwrites a lead's real original source (HubSpot, Referral, etc.); it just gives leads with no attribution on file a real value once Prospero touches them, so the board's source pill has something to show.

## 9. Manual template sends (outreach layer)

Every email — qualification, lead-gen, follow-up, booking — sends only when Mary clicks Send after previewing it, via the new "📄 Templates" button on a lead's detail row in Sales Pipeline. There is no automatic dispatch based on a lead's stage, score, or any webhook event; that's an explicitly out-of-scope future phase. `send-template` is not gated by the auto-send kill switch (step 1/7) — that switch exists to hold back *unattended* sends, and every call into `send-template` is already human-initiated by definition.

**Hard dependency: Mary's Gmail must be connected under her own account (`mary@social-practicetx.com`), not Zane's personal Gmail.** `send-template` checks the connected account's email at send time and refuses (with a clear logged reason, no email sent) if it doesn't match. As of this build, Mary's Gmail has not yet been reconnected under her own account in Settings — it's currently deferred/using a different account. Reconnect it via Settings → Email → "Connect Gmail" before Templates can send anything; until then, every send attempt will fail this check by design, which is the intended stand-in for a stubbed TODO (a real runtime guard, not commented-out code, so it self-resolves the moment the reconnection happens).

Every send writes to `comm_log` and — best-effort, non-blocking — pushes a note to the contact's HubSpot timeline (not a structured property, so it can't accidentally trip a property-based Workflow). Whether Mary's Gmail account also has HubSpot's native Gmail/Sales-extension sync active (which would log the email a second time on HubSpot's side) **could not be confirmed from this codebase** — that's a Google Workspace / HubSpot Sales Hub account setting, not something Sales-AI stores. Check Mary's HubSpot account settings directly once her Gmail is reconnected; if native sync is on, the timeline note here is intentionally redundant rather than harmful.

Qualification overrides (the Qualified / Not Yet / Needs Review buttons next to the deterministic score) follow the same manual, write-back-immediately pattern: an override is a human decision layered on top of the deterministic score, never a replacement for it — both stay on file and visible — and saving one also pushes a HubSpot timeline note the same way.

## 10. Lead Board → drill-down stage navigation + fake-lead cleanup

Sales Pipeline's flat table and separate "Cold Leads" table are gone (see step 1's `supabase_schema_v13.sql` note for the stage-rename migration that went with this). They were first replaced by a horizontally-scrolling Kanban board, then that board itself was replaced by the current **drill-down navigation** — a side-scrolling board doesn't fit well once you have 9 stages. Stat cards and the filter bar are unchanged and stay visible above the list; only the list/detail layer underneath them changed shape:

- **Level 1 (default view):** a vertical list of all 9 stages, each showing a count of leads currently in it — the count respects whatever's set in the filter bar above (search/source/practice/qualification/cold-only).
- **Level 2:** tapping a stage shows just its leads, as the same cards as before (unchanged content/styling) in a vertical list, with a "☰ Back to Stages" control and a breadcrumb ("Stage Name (count)") above them.
- **Level 3:** tapping a card no longer opens a modal over the board — it navigates to a real, deep-linkable URL, `/leads/<lead-id>`, showing that lead full-page (same content the old modal had: qualification score + override, Templates button, comms history, edit/delete, etc.), with a stage-change `<select>` on the page itself now that there's no board to drag a card onto. This still calls the same `changeLeadStage()` function — Supabase write + HubSpot deal-stage push are unchanged.

**This introduces real client-side routing via the History API, which this app never had before** — `openLeadPage()`/`renderLeadPage()`/a `popstate` listener in `index.html`. Because it's a static single-page app with no server-side router, a *direct* load of `/leads/<id>` (a shared link, or hitting refresh while viewing one) needs the host to serve `index.html` for that path instead of 404ing — that's what the new **`vercel.json`** (repo root) does, with a narrowly-scoped rewrite (`/leads/(.*)` → `/index.html`) that doesn't touch how `/`, `questionnaire.html`, or anything else is served. **This file didn't exist before this pass — make sure it's included in the next deploy**, or deep links to individual leads will 404 on the live site even though in-app navigation to them works fine (in-app navigation never does a real page load, so it wouldn't surface the missing-rewrite problem until someone actually shares or refreshes a lead link). `serve.json` (used by the local dev server, not by Vercel) got the equivalent rewrite for the same reason.

Removed along with the old board: drag-and-drop stage changes (no columns to drag between anymore — replaced by the stage `<select>` on the Level 3 page) and the generic multi-select "Delete Selected" bulk-delete bar from an even earlier pass (no table row left to host a checkbox column). Single-lead delete is unchanged, now reached via the Level 3 page. The **Settings → 🧹 Data Cleanup** section is the closest replacement for reviewed bulk deletion going forward — see below.

**Data Cleanup** scans `leads` for likely test/sample rows (`@hubspot.com` emails, "test" in the name, or a short list of known dev-testing entries) and shows them in a review list with a checkbox per row — nothing is deleted until you check the ones you want gone and confirm. It deletes from Supabase only, at the same authorization level as the app's existing lead deletes (no new admin-password gate was added specifically for this, since a per-record review list was the safeguard the spec asked for, not an additional password). **It does not touch HubSpot.** If a "fake" lead still exists in HubSpot when you delete it here, the next `hubspot-webhook-receiver` event or HubSpot sync run will simply recreate it — the modal says this explicitly, but the real fix is deleting the record in HubSpot's own UI too (or before deleting it here).

## Known gaps to confirm once you have real API access

- **Read.ai**: `pull-transcripts`'s endpoint (`api.read.ai/v1/sessions`) and field names (`session.attendees`, `session.transcript`, etc.) are a best-effort guess at a reasonable REST shape — adjust once you can see Read.ai's actual API docs or a sample response. The same guessed endpoint is used for the Read.ai key test in `save-credential`.
- **Read.ai OAuth 2.1 scaffold** (`read-ai-authorize`, `read-ai-oauth-callback`, `_shared/readAiClient.ts`, `read_ai_tokens` table): structure only, not a working integration. No Read.ai OAuth app is registered yet, so `READ_AI_CLIENT_ID`/`READ_AI_CLIENT_SECRET`/`READ_AI_AUTH_URL`/`READ_AI_TOKEN_URL`/`READ_AI_REDIRECT_URI` are unset — both functions throw a clear "not configured" error until they're set. Requested OAuth scopes in `read-ai-authorize` and the endpoint path in `readAiClient.ts`'s `getMeetingSummary()` are explicitly marked `TODO` placeholders, not guesses presented as real — confirm both against Read.ai's actual docs once available. This is entirely separate from the API-key-based Read.ai integration `pull-transcripts` already uses; that one is untouched.
- **HubSpot note-to-deal association**: `createHubspotNote` (in `_shared/hubspot.ts`) uses `associationTypeId: 214` for note-to-deal, which is HubSpot's documented default but not independently verified against a live account. The note-to-contact association (`202`) came from HubSpot's docs via earlier work in this app and is trusted. If deal association silently doesn't show up in HubSpot, the note itself still lands on the contact — that part degrades gracefully.
- **Proposal deck automation (4 custom pages)**: intentionally not built. Proposal Builder itself (generic AI proposal generation) was removed from the frontend entirely as part of the no-LLM redesign.
- **HubSpot v3 webhook signature**: implemented per HubSpot's documented spec but not yet exercised against a live HubSpot App/delivery — see step 8a.
- **Prospero payload shape**: unknown until real deliveries arrive; `extractDealFields` in `prospero-webhook-receiver/index.ts` is a defensive best-effort guess, not a confirmed mapping — see step 8b. Nothing crashes on an unexpected shape; the raw payload is always preserved in `prospero_events` regardless.
- **HubSpot Deal associations** (`upsertHubspotDeal` in `_shared/hubspot.ts`): uses the same unverified-but-documented-default association type IDs as the existing note-to-deal association (see the entry above); wrapped so an association failure never blocks the underlying Deal write.
- **Mary's Gmail → HubSpot reconnection**: not done as of this build — `send-template` hard-blocks on it. See step 9.
- **Native HubSpot Gmail sync status**: unknown/unconfirmed from this codebase for Mary's account — see step 9.
- **Template copy**: the 16 seeded `templates` rows are placeholders (name + category only, from `supabase_schema_v12.sql`) — actual subject/body copy still needs to be written from the brand-voice guide before these are usable for a real send.

## Lead sources

HubSpot is the single lead-entry point and system of record. `sync-hubspot-leads` is the sole automated path new leads enter the pipeline — ad platforms (Facebook, Instagram, Google, LinkedIn) feed HubSpot directly on HubSpot's side, so every synced lead is simply tagged `source: 'HubSpot'`. Manual lead entry ("+ Add Lead" in the Sales Pipeline tab) remains available as a fallback for leads that aren't in HubSpot yet — those can be tagged Referral, Website, Cold Outreach, or Other.

HubSpot Workflows are expected to own outbound lead email going forward. This repo's backend still sends a few transactional emails itself (questionnaire link, proposed meeting time) via Gmail, but as static templates with no AI drafting — see the note under step 4 above.
