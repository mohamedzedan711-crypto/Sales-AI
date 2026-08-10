// HubSpot webhook receiver — the "detection layer" for Contacts and
// Companies. HubSpot POSTs here the instant a subscribed event fires; no
// polling, no pg_cron (not available in this Supabase project anyway).
//
// Subscribes to: contact.creation, contact.propertyChange,
// company.creation, company.propertyChange. On receipt: verifies the
// HubSpot v3 signature, pulls the FULL record for whatever changed (a
// webhook event only tells you an objectId changed, not what its current
// properties are), fetches the associated Company for a Contact (or
// every associated Contact for a Company), and upserts leads/companies —
// filling gaps only, never overwriting a human's own edits (see
// _shared/hubspotSync.ts).
//
// SCAFFOLD NOTE: signature verification (_shared/hubspotWebhookAuth.ts)
// requires HUBSPOT_CLIENT_SECRET, which requires registering an actual
// HubSpot App with a webhook subscription — that doesn't exist yet.
// Until it does, every request is rejected with a clear, logged reason.
// See DEPLOYMENT.md for the exact HubSpot-side setup steps (subscription
// types, target URL, where the Client Secret comes from) — that part
// happens in HubSpot's UI, not in this file.
//
// This is DETECTION only, per the product decision this build follows:
// it upserts data, it never sends anything (no email, no outreach). The
// "outreach layer" (send-template) is separate and stays manual.
//
// FORM SUBMISSIONS: HubSpot's CRM webhooks have no distinct "a form was
// submitted" event type — a form submission arrives here as an ordinary
// contact.propertyChange, indistinguishable at the event level from a
// manual edit in HubSpot's UI. Investigated for the "Discovery
// Qualification Form" specifically (a real, live HubSpot-native form,
// confirmed against actual submitted contacts in the connected portal —
// this is NOT the same thing as this repo's own questionnaire.html,
// which has no HubSpot involvement at all): before this comment was
// added, a submission's answers were fetched by nothing (they weren't
// even in getHubspotContactById's properties list) and, even if they
// had been, upsertLeadFromHubspotContact only fills leads-table gaps —
// no distinguishable event ever reached comm_log. Fixed by (1) widening
// getHubspotContactById's properties to include the form's answer
// fields plus HubSpot's generic recent_conversion_event_name/date, and
// (2) maybeLogQualificationFormSubmission() below, which recognizes
// that specific form by name and writes a dated comm_log entry the
// first time it sees a new submission (idempotent via
// leads.last_qualification_form_submission_at — see
// _shared/hubspotSync.ts and supabase_schema_v14.sql). See
// DEPLOYMENT.md for the full writeup, including why this can't be made
// fully robust without a distinct HubSpot Forms webhook.
//
// No LLM calls anywhere in this file.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { requireCredential } from '../_shared/credentials.ts';
import {
  getHubspotContactById,
  getHubspotCompanyById,
  getAssociatedCompanyId,
  getAssociatedContactIds,
} from '../_shared/hubspot.ts';
import {
  upsertLeadFromHubspotContact,
  upsertCompanyFromHubspot,
  maybeLogQualificationFormSubmission,
} from '../_shared/hubspotSync.ts';
import { verifyHubspotSignatureV3 } from '../_shared/hubspotWebhookAuth.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

interface HubspotWebhookEvent {
  objectId: number | string;
  subscriptionType: string; // 'contact.creation' | 'contact.propertyChange' | 'company.creation' | 'company.propertyChange'
  occurredAt?: number;
}

// A single webhook delivery can contain several events for the same
// object (e.g. three properties changed in one edit = three event
// entries with the same objectId). We always refetch the full record
// regardless of which property changed, so there's no reason to hit the
// HubSpot API more than once per distinct object per batch.
function dedupeEvents(events: HubspotWebhookEvent[]): { type: 'contact' | 'company'; objectId: string }[] {
  const seen = new Map<string, { type: 'contact' | 'company'; objectId: string }>();
  for (const event of events) {
    const type = event.subscriptionType?.startsWith('company.') ? 'company' : 'contact';
    const key = `${type}:${event.objectId}`;
    if (!seen.has(key)) seen.set(key, { type, objectId: String(event.objectId) });
  }
  return Array.from(seen.values());
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();

    // Raw body text is needed verbatim for signature verification — must
    // be read before any JSON.parse.
    const rawBody = await req.text();
    const signatureCheck = await verifyHubspotSignatureV3(
      req.method,
      req.url,
      rawBody,
      req.headers.get('X-HubSpot-Signature-v3'),
      req.headers.get('X-HubSpot-Request-Timestamp')
    );
    if (!signatureCheck.valid) {
      await logAutomationFailure(supabaseAdmin, 'hubspot-webhook-receiver', `Rejected: ${signatureCheck.reason}`);
      return new Response(JSON.stringify({ ok: false, error: signatureCheck.reason }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let events: HubspotWebhookEvent[];
    try {
      events = JSON.parse(rawBody);
      if (!Array.isArray(events)) throw new Error('Expected an array of events');
    } catch (e) {
      await logAutomationFailure(supabaseAdmin, 'hubspot-webhook-receiver', `Could not parse webhook payload: ${String(e)}`);
      return new Response(JSON.stringify({ ok: false, error: 'Invalid payload' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const hubspotCred = await requireCredential(supabaseAdmin, 'hubspot', 'HubSpot');

    let processed = 0;
    const skipped: string[] = [];
    const sourceErrors: string[] = [];

    for (const { type, objectId } of dedupeEvents(events)) {
      try {
        if (type === 'contact') {
          const contact = await getHubspotContactById(hubspotCred.value, objectId);

          let companyId: string | null = null;
          try {
            const hubspotCompanyId = await getAssociatedCompanyId(hubspotCred.value, objectId);
            if (hubspotCompanyId) {
              const company = await getHubspotCompanyById(hubspotCred.value, hubspotCompanyId);
              companyId = await upsertCompanyFromHubspot(supabaseAdmin, company);
            }
          } catch (e) {
            // Best-effort — a lead can still be upserted without its company linked.
            await logAutomationFailure(
              supabaseAdmin,
              'hubspot-webhook-receiver',
              `Contact ${objectId}: could not fetch/upsert associated company: ${String(e)}`
            );
          }

          const { id: leadId } = await upsertLeadFromHubspotContact(supabaseAdmin, contact, companyId);
          try {
            await maybeLogQualificationFormSubmission(supabaseAdmin, leadId, contact);
          } catch (e) {
            // Best-effort — the lead upsert above already succeeded either way.
            await logAutomationFailure(
              supabaseAdmin,
              'hubspot-webhook-receiver',
              `Contact ${objectId}: lead upserted, but logging a possible qualification-form submission failed: ${String(e)}`,
              leadId
            );
          }
          processed++;
        } else {
          const company = await getHubspotCompanyById(hubspotCred.value, objectId);
          const companyId = await upsertCompanyFromHubspot(supabaseAdmin, company);

          const contactIds = await getAssociatedContactIds(hubspotCred.value, objectId);
          for (const contactId of contactIds) {
            try {
              const contact = await getHubspotContactById(hubspotCred.value, contactId);
              const { id: leadId } = await upsertLeadFromHubspotContact(supabaseAdmin, contact, companyId);
              try {
                await maybeLogQualificationFormSubmission(supabaseAdmin, leadId, contact);
              } catch (e) {
                await logAutomationFailure(
                  supabaseAdmin,
                  'hubspot-webhook-receiver',
                  `Company ${objectId} -> contact ${contactId}: lead upserted, but logging a possible qualification-form submission failed: ${String(e)}`,
                  leadId
                );
              }
            } catch (e) {
              skipped.push(`company ${objectId} -> contact ${contactId}`);
              await logAutomationFailure(
                supabaseAdmin,
                'hubspot-webhook-receiver',
                `Company ${objectId}: could not fetch/upsert associated contact ${contactId}: ${String(e)}`
              );
            }
          }
          processed++;
        }
      } catch (e) {
        skipped.push(`${type} ${objectId}`);
        sourceErrors.push(`${type} ${objectId}: ${String(e)}`);
        await logAutomationFailure(
          supabaseAdmin,
          'hubspot-webhook-receiver',
          `Could not process ${type} ${objectId}: ${String(e)}`
        );
      }
    }

    return new Response(JSON.stringify({ ok: true, processed, skipped, sourceErrors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    try { await logAutomationFailure(getSupabaseAdmin(), 'hubspot-webhook-receiver', `Run failed entirely: ${String(e)}`); } catch { /* logging itself failed, nothing more to do */ }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
