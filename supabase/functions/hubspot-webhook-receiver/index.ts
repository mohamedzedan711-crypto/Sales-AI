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
// No LLM calls anywhere in this file.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { requireCredential } from '../_shared/credentials.ts';
import {
  getHubspotContactById,
  getHubspotCompanyById,
  getAssociatedCompanyId,
  getAssociatedContactIds,
} from '../_shared/hubspot.ts';
import { upsertLeadFromHubspotContact, upsertCompanyFromHubspot } from '../_shared/hubspotSync.ts';
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

          await upsertLeadFromHubspotContact(supabaseAdmin, contact, companyId);
          processed++;
        } else {
          const company = await getHubspotCompanyById(hubspotCred.value, objectId);
          const companyId = await upsertCompanyFromHubspot(supabaseAdmin, company);

          const contactIds = await getAssociatedContactIds(hubspotCred.value, objectId);
          for (const contactId of contactIds) {
            try {
              const contact = await getHubspotContactById(hubspotCred.value, contactId);
              await upsertLeadFromHubspotContact(supabaseAdmin, contact, companyId);
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
