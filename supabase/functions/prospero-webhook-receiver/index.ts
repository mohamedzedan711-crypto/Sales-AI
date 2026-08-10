// Prospero webhook receiver — Prospero has no API key, it's webhook-only,
// so this function IS the endpoint Prospero calls out to. We do not poll
// Prospero.
//
// PAYLOAD SHAPE IS UNKNOWN. This is the load-bearing fact of this file:
// the raw payload is logged to prospero_events VERBATIM, first, always,
// unconditionally — before any extraction is attempted — so nothing is
// lost while field-mapping is finalized against real Prospero payloads.
// Everything after that point is best-effort and defensive: extraction
// tries several plausible field names/nesting depths per field rather
// than assuming one specific shape, and any field that doesn't resolve
// is left null rather than guessed. Confirm and correct the field names
// in extractDealFields() below once real Prospero payloads are seen —
// treat this version as a starting point, not a finished mapping.
//
// Matching: contact email first (exact, case-insensitive, no HubSpot
// call needed), then a CONTAINS_TOKEN fuzzy search against HubSpot's
// Company name property if no email match. This fuzzy-match logic is
// newly written for this pass — there was no prior "Monday migration"
// implementation of it anywhere in this codebase to reuse.
//
// Sales-AI is the middleware: if matched, the deal is upserted into our
// own `deals` table AND pushed to HubSpot as a Deal object (create or
// update). Prospero and HubSpot never talk to each other directly.
//
// No LLM calls anywhere in this file.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { getCredential } from '../_shared/credentials.ts';
import { searchHubspotCompaniesByName, upsertHubspotDeal } from '../_shared/hubspot.ts';
import { upsertCompanyFromHubspot } from '../_shared/hubspotSync.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

interface ExtractedDeal {
  dealName: string | null;
  contactEmail: string | null;
  companyName: string | null;
  stage: string | null;
  value: number | null;
  status: string | null;
  prosperoDealId: string | null;
}

function extractString(source: any, keys: string[]): string | null {
  for (const key of keys) {
    const val = source?.[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return null;
}

function extractNumber(source: any, keys: string[]): number | null {
  for (const key of keys) {
    const val = source?.[key];
    if (typeof val === 'number') return val;
    if (typeof val === 'string' && val.trim() && !Number.isNaN(Number(val))) return Number(val);
  }
  return null;
}

// Best-effort field extraction — see file header. Tries a nested
// contact/company/deal object first (several plausible key names for
// each), then falls back to the top level of the payload.
function extractDealFields(payload: any): ExtractedDeal {
  const p = payload || {};
  const contact = p.contact || p.client || p.customer || {};
  const company = p.company || p.business || p.practice || {};
  const deal = p.deal || p.proposal || p;

  return {
    dealName: extractString(deal, ['name', 'deal_name', 'dealName', 'title', 'proposal_name']),
    contactEmail:
      extractString(contact, ['email', 'contact_email']) ||
      extractString(p, ['email', 'contact_email']),
    companyName:
      extractString(company, ['name', 'company_name', 'business_name', 'practice_name']) ||
      extractString(p, ['company_name', 'business_name', 'practice_name']),
    stage: extractString(deal, ['stage', 'deal_stage', 'status']),
    value: extractNumber(deal, ['value', 'amount', 'deal_value', 'total']),
    status: extractString(deal, ['status', 'proposal_status', 'state']),
    prosperoDealId:
      extractString(deal, ['id', 'deal_id', 'proposal_id']) ||
      extractString(p, ['id', 'event_id']),
  };
}

// Exactly one lead tied to this company: use it. Zero or multiple: don't
// guess which one — leave the deal linked to the company only.
async function findSoleLeadForCompany(supabaseAdmin: any, companyId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('leads')
    .select('id')
    .eq('company_id', companyId)
    .limit(2);
  if (!data || data.length !== 1) return null;
  return data[0].id;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();

    let rawPayload: any;
    try {
      rawPayload = await req.json();
    } catch {
      // Not even valid JSON — still log something so nothing is lost.
      rawPayload = { __unparseable_raw_text: await req.text() };
    }

    // Log verbatim FIRST, unconditionally — before any extraction attempt.
    const { data: eventRow, error: logError } = await supabaseAdmin
      .from('prospero_events')
      .insert([{ raw_payload: rawPayload }])
      .select('id')
      .single();
    if (logError || !eventRow) {
      await logAutomationFailure(supabaseAdmin, 'prospero-webhook-receiver', `Could not log raw Prospero payload: ${logError?.message}`);
    }
    const eventId: string | null = eventRow?.id || null;

    let processed = 0;
    const skipped: string[] = [];
    const sourceErrors: string[] = [];

    try {
      const extracted = extractDealFields(rawPayload);
      // getCredential (not requireCredential) — matching by email needs
      // no HubSpot call at all, so a missing HubSpot connection shouldn't
      // block that path; it only limits the fuzzy-match and HubSpot-push
      // steps further down, which check for hubspotCred themselves.
      const hubspotCred = await getCredential(supabaseAdmin, 'hubspot');

      let leadId: string | null = null;
      let companyId: string | null = null;
      let hubspotContactId: string | null = null;
      let hubspotCompanyId: string | null = null;

      if (extracted.contactEmail) {
        const { data: lead } = await supabaseAdmin
          .from('leads')
          .select('id, hubspot_contact_id, company_id')
          .ilike('email', extracted.contactEmail)
          .maybeSingle();
        if (lead) {
          leadId = lead.id;
          hubspotContactId = lead.hubspot_contact_id;
          companyId = lead.company_id;
        }
      }

      if (!leadId && extracted.companyName && hubspotCred) {
        try {
          const results = await searchHubspotCompaniesByName(hubspotCred.value, extracted.companyName, 3);
          if (results.length) {
            companyId = await upsertCompanyFromHubspot(supabaseAdmin, results[0]);
            hubspotCompanyId = String(results[0].id);
            leadId = await findSoleLeadForCompany(supabaseAdmin, companyId);
          }
        } catch (e) {
          sourceErrors.push('HubSpot company search: ' + String(e));
          await logAutomationFailure(
            supabaseAdmin,
            'prospero-webhook-receiver',
            `Company fuzzy-match search failed for "${extracted.companyName}": ${String(e)}`
          );
        }
      } else if (!leadId && extracted.companyName && !hubspotCred) {
        sourceErrors.push('HubSpot not connected — could not attempt company fuzzy match.');
      }

      if (!leadId && !companyId) {
        skipped.push('no matching lead or company');
        await logAutomationFailure(
          supabaseAdmin,
          'prospero-webhook-receiver',
          `No matching lead/company found (email: ${extracted.contactEmail || 'none'}, company: ${extracted.companyName || 'none'}) — raw payload preserved in prospero_events (id ${eventId}); not upserted into deals.`
        );
        if (eventId) {
          await supabaseAdmin
            .from('prospero_events')
            .update({ processed: false, processing_error: 'No matching lead or company found.' })
            .eq('id', eventId);
        }
        return new Response(JSON.stringify({ ok: true, processed, skipped, sourceErrors }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Matched a lead but don't yet know its company's HubSpot id — the
      // lead's own company_id may already resolve to one on file.
      if (companyId && !hubspotCompanyId) {
        const { data: companyRow } = await supabaseAdmin
          .from('companies')
          .select('hubspot_company_id')
          .eq('id', companyId)
          .maybeSingle();
        hubspotCompanyId = companyRow?.hubspot_company_id || null;
      }

      // Upsert into deals — matched by prospero_deal_id if we have one
      // and a row already exists for it.
      let existingDeal: { id: string; hubspot_deal_id: string | null } | null = null;
      if (extracted.prosperoDealId) {
        const { data } = await supabaseAdmin
          .from('deals')
          .select('id, hubspot_deal_id')
          .eq('prospero_deal_id', extracted.prosperoDealId)
          .maybeSingle();
        existingDeal = data;
      }

      const dealFields = {
        lead_id: leadId,
        company_id: companyId,
        prospero_deal_id: extracted.prosperoDealId,
        name: extracted.dealName,
        stage: extracted.stage,
        value: extracted.value,
        status: extracted.status,
        updated_at: new Date().toISOString(),
      };

      let dealRowId: string;
      const hubspotDealId: string | null = existingDeal?.hubspot_deal_id || null;
      if (existingDeal) {
        await supabaseAdmin.from('deals').update(dealFields).eq('id', existingDeal.id);
        dealRowId = existingDeal.id;
      } else {
        const { data: inserted, error: insertError } = await supabaseAdmin
          .from('deals')
          .insert([dealFields])
          .select('id')
          .single();
        if (insertError || !inserted) throw new Error(`Could not create deal: ${insertError?.message}`);
        dealRowId = inserted.id;
      }

      // Push to HubSpot as a Deal — best-effort; the local deals row above
      // already succeeded either way, which is what keeps the data from
      // being lost even if this step fails.
      if (hubspotCred) {
        try {
          const hsProps: Record<string, string | number> = {};
          if (extracted.dealName) hsProps.dealname = extracted.dealName;
          if (extracted.value != null) hsProps.amount = extracted.value;
          if (extracted.stage) hsProps.dealstage = extracted.stage;

          const newHubspotDealId = await upsertHubspotDeal(hubspotCred.value, hubspotDealId, hsProps, {
            contactId: hubspotContactId,
            companyId: hubspotCompanyId,
          });
          await supabaseAdmin.from('deals').update({ hubspot_deal_id: newHubspotDealId }).eq('id', dealRowId);
        } catch (e) {
          sourceErrors.push('HubSpot deal push: ' + String(e));
          await logAutomationFailure(
            supabaseAdmin,
            'prospero-webhook-receiver',
            `Deal saved locally (id ${dealRowId}), but pushing to HubSpot failed: ${String(e)}`,
            leadId
          );
        }
      } else {
        sourceErrors.push('HubSpot not connected — deal saved locally only, not pushed to HubSpot.');
        await logAutomationFailure(
          supabaseAdmin,
          'prospero-webhook-receiver',
          `Deal saved locally (id ${dealRowId}), but HubSpot is not connected — nothing pushed.`,
          leadId
        );
      }

      processed++;
      if (eventId) {
        await supabaseAdmin.from('prospero_events').update({ processed: true, processing_error: null }).eq('id', eventId);
      }
    } catch (e) {
      sourceErrors.push(String(e));
      await logAutomationFailure(supabaseAdmin, 'prospero-webhook-receiver', `Could not process Prospero event (id ${eventId}): ${String(e)}`);
      if (eventId) {
        await supabaseAdmin.from('prospero_events').update({ processed: false, processing_error: String(e) }).eq('id', eventId);
      }
    }

    return new Response(JSON.stringify({ ok: true, processed, skipped, sourceErrors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    try { await logAutomationFailure(getSupabaseAdmin(), 'prospero-webhook-receiver', `Run failed entirely: ${String(e)}`); } catch { /* logging itself failed, nothing more to do */ }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
