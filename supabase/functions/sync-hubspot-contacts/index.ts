// Incremental HubSpot contact sync into `leads`, using HubSpot's CRM
// Search API with a stored last-synced cursor (hubspot_sync_state, schema
// v11) instead of pulling every contact on every run.
//
// SEPARATE FROM sync-hubspot-leads/index.ts ON PURPOSE — that function is
// untouched by this one. It syncs contacts via a plain unpaginated GET,
// sends the questionnaire email to new leads, and is cron-scheduled as
// the funnel's entry point (see DEPLOYMENT.md). This function is a
// second, independent HubSpot→leads path: no email sending, no
// questionnaire funnel involvement, no auto-send-kill-switch dependency
// (nothing here is a "send").
//
// AUTH: uses the standard requireCredential('hubspot') pattern from
// _shared/credentials.ts — same as every other HubSpot-touching function
// in this codebase (checks api_credentials / Settings first, falls back
// to the HUBSPOT_API_KEY Supabase secret). This function originally used
// a raw Deno.env.get("HUBSPOT_SERVICE_KEY") per its own spec at the time;
// corrected to the standard pattern and the correct secret name
// (HUBSPOT_API_KEY, not HUBSPOT_SERVICE_KEY) for consistency with the
// rest of the codebase, before this function was ever deployed.
//
// Existing leads are only ever filled in (hubspot_contact_id set when
// null), never overwritten — contact_name, stage, notes, and everything
// else stay exactly as Zane/Mary left them. New leads are inserted with
// only source: 'HubSpot' and stage: 'New Lead'.
//
// Dry-run mode (?dryRun=true) computes and returns what WOULD happen —
// inserts, updates, skips — with zero writes anywhere (leads,
// hubspot_sync_state, and automation_failures are all untouched while
// dry-running; a preview is meant to be inspectable from the response
// alone, not from the Automation Activity log). One narrow exception:
// if HubSpot isn't connected at all, requireCredential throws before the
// dry-run check further down runs, so that one specific failure IS
// logged to automation_failures even during a dry run — an accepted,
// minor inconsistency, since there's nothing to preview if HubSpot was
// never connected in the first place.
//
// No LLM calls anywhere in this file. Deterministic logic only.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { requireCredential } from '../_shared/credentials.ts';
import { findLeadByHubspotIdOrEmail } from '../_shared/hubspotSync.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

const HUBSPOT_SEARCH_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
const PAGE_LIMIT = 100;

interface HubspotContact {
  id: string;
  properties: Record<string, string | null>;
}

// Loops HubSpot's CRM Search API using paging.next.after until it stops
// returning one, accumulating every page. Filters server-side on
// lastmodifieddate greater than sinceIso.
//
// NOTE: HubSpot's Search API expects date/datetime property filter values
// as millisecond epoch timestamps (its documented convention for this
// endpoint) — not an ISO string. Not independently re-verified against a
// live account in this pass; confirm on first real run.
async function searchHubspotContacts(key: string, sinceIso: string): Promise<HubspotContact[]> {
  const sinceMs = new Date(sinceIso).getTime();
  const results: HubspotContact[] = [];
  let after: string | undefined;

  while (true) {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [{
          propertyName: 'lastmodifieddate',
          operator: 'GT',
          value: String(sinceMs),
        }],
      }],
      properties: ['email', 'firstname', 'lastname', 'company', 'hs_object_id', 'createdate', 'lastmodifieddate'],
      limit: PAGE_LIMIT,
    };
    if (after) body.after = after;

    const res = await fetch(HUBSPOT_SEARCH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`HubSpot contacts search failed (${res.status}): ${await res.text()}`);
    }
    const page = await res.json();
    const items: HubspotContact[] = page.results || [];
    results.push(...items);

    const nextAfter = page.paging?.next?.after;
    if (!nextAfter) break;
    after = nextAfter;
  }

  return results;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const url = new URL(req.url);
    const dryRun = url.searchParams.get('dryRun') === 'true';

    // Dry-run makes zero writes anywhere, including automation_failures —
    // a preview run shouldn't leave a trace in Automation Activity as if
    // something unattended actually happened.
    const maybeLog = async (detail: string, leadId?: string | null) => {
      if (dryRun) return;
      await logAutomationFailure(supabaseAdmin, 'sync-hubspot-contacts', detail, leadId ?? null);
    };

    const hubspotCred = await requireCredential(supabaseAdmin, 'hubspot', 'HubSpot');
    const hubspotKey = hubspotCred.value;

    const runStartedAt = new Date();

    const { data: syncState } = await supabaseAdmin
      .from('hubspot_sync_state')
      .select('last_synced_at')
      .eq('id', 1)
      .maybeSingle();
    const sinceIso = syncState?.last_synced_at || '1970-01-01T00:00:00Z';

    const contacts: HubspotContact[] = [];
    const sourceErrors: string[] = [];
    try {
      contacts.push(...(await searchHubspotContacts(hubspotKey, sinceIso)));
    } catch (e) {
      sourceErrors.push('HubSpot: ' + String(e));
      await maybeLog('HubSpot contacts search failed: ' + String(e));
    }

    let processed = 0;
    const skipped: string[] = [];
    const preview: any[] = [];

    for (const contact of contacts) {
      const props = contact.properties || {};
      const hsObjectId = props.hs_object_id || contact.id;
      const email = (props.email || '').trim();

      if (!email) {
        skipped.push(`no email (HubSpot contact ${hsObjectId})`);
        await maybeLog(`No email on HubSpot contact ${hsObjectId}`);
        if (dryRun) preview.push({ action: 'skip', hubspot_contact_id: hsObjectId, reason: 'no email' });
        continue;
      }

      const lead = await findLeadByHubspotIdOrEmail(supabaseAdmin, hsObjectId as string, email);

      if (lead) {
        if (lead.hubspot_contact_id) {
          // Already fully synced — leave everything untouched.
          skipped.push(`already exists, hubspot_contact_id set (${email})`);
          if (dryRun) preview.push({ action: 'skip', email, lead_id: lead.id, reason: 'already exists, hubspot_contact_id set' });
          continue;
        }

        if (dryRun) {
          preview.push({ action: 'update', email, lead_id: lead.id, set: { hubspot_contact_id: hsObjectId } });
          processed++;
          continue;
        }

        const { error: updateError } = await supabaseAdmin
          .from('leads')
          .update({ hubspot_contact_id: hsObjectId })
          .eq('id', lead.id);
        if (updateError) {
          skipped.push(`update failed for ${email}: ${updateError.message}`);
          await maybeLog(`Could not set hubspot_contact_id for lead matched by email ${email}: ${updateError.message}`, lead.id);
          continue;
        }
        processed++;
        continue;
      }

      // No matching lead — insert a new one. Only the fields this sync
      // actually knows are set; nothing here overwrites an existing
      // record since this branch only runs when none was found.
      const contactName = `${props.firstname || ''} ${props.lastname || ''}`.trim();
      const newLead = {
        contact_name: contactName || null,
        email,
        business_name: props.company || null,
        hubspot_contact_id: hsObjectId,
        source: 'HubSpot',
        stage: 'New Lead',
      };

      if (dryRun) {
        preview.push({ action: 'insert', ...newLead });
        processed++;
        continue;
      }

      const { error: insertError } = await supabaseAdmin.from('leads').insert([newLead]);
      if (insertError) {
        skipped.push(`insert failed for ${email}: ${insertError.message}`);
        await maybeLog(`Could not create lead for HubSpot contact ${hsObjectId} (${email}): ${insertError.message}`);
        continue;
      }
      processed++;
    }

    if (!dryRun) {
      await supabaseAdmin
        .from('hubspot_sync_state')
        .update({ last_synced_at: runStartedAt.toISOString(), updated_at: new Date().toISOString() })
        .eq('id', 1);
    }

    const responseBody: Record<string, unknown> = { ok: true, processed, skipped, sourceErrors };
    if (dryRun) {
      responseBody.dryRun = true;
      responseBody.preview = preview;
    }

    return new Response(JSON.stringify(responseBody), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    try { await logAutomationFailure(getSupabaseAdmin(), 'sync-hubspot-contacts', `Run failed entirely: ${String(e)}`); } catch { /* logging itself failed, nothing more to do */ }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
