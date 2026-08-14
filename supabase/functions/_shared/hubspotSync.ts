// Shared HubSpot -> leads/companies matching and upsert logic. Used by
// sync-hubspot-contacts, hubspot-webhook-receiver, and (for the
// company-upsert half only) prospero-webhook-receiver — factored out here
// once three call sites needed the same behavior, rather than duplicating
// it a third time.
//
// The one rule every caller follows: HubSpot only fills in gaps on an
// existing lead (hubspot_contact_id / company_id when null), never
// overwrites contact_name, stage, notes, or anything else a human has
// already set.

import { DISCOVERY_QUALIFICATION_FORM_PROPERTIES } from './hubspot.ts';

// Matches a HubSpot contact to an existing lead: first by
// hubspot_contact_id (an exact link already made), then by email
// (case-insensitive). Two sequential .maybeSingle() calls rather than one
// combined .or() filter, so two separately-matching leads (a known
// possibility here — see leads.duplicate_flag) can't make a single query
// throw on multiple rows.
export async function findLeadByHubspotIdOrEmail(
  supabaseAdmin: any,
  hubspotContactId: string | null,
  email: string | null
): Promise<{ id: string; hubspot_contact_id: string | null; company_id: string | null } | null> {
  if (hubspotContactId) {
    const { data } = await supabaseAdmin
      .from('leads')
      .select('id, hubspot_contact_id, company_id')
      .eq('hubspot_contact_id', hubspotContactId)
      .maybeSingle();
    if (data) return data;
  }
  if (email) {
    const { data } = await supabaseAdmin
      .from('leads')
      .select('id, hubspot_contact_id, company_id')
      .ilike('email', email)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

// Upserts a companies row from a HubSpot Company record (as returned by
// getHubspotCompanyById / searchHubspotCompaniesByName). Matched by
// hubspot_company_id. Returns the internal companies.id.
export async function upsertCompanyFromHubspot(supabaseAdmin: any, hubspotCompany: any): Promise<string> {
  const hubspotCompanyId = String(hubspotCompany.id);
  const props = hubspotCompany.properties || {};

  const { data: existing } = await supabaseAdmin
    .from('companies')
    .select('id')
    .eq('hubspot_company_id', hubspotCompanyId)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from('companies')
      .update({ name: props.name || null, domain: props.domain || null, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    return existing.id;
  }

  const { data: inserted, error } = await supabaseAdmin
    .from('companies')
    .insert([{ hubspot_company_id: hubspotCompanyId, name: props.name || null, domain: props.domain || null }])
    .select('id')
    .single();
  if (error || !inserted) throw new Error(`Could not upsert company ${hubspotCompanyId}: ${error?.message}`);
  return inserted.id;
}

// Human-readable labels for the Discovery Qualification Form's answer
// fields — used only when building the comm_log summary below, kept
// next to DISCOVERY_QUALIFICATION_FORM_PROPERTIES (the source of truth
// for which fields exist) rather than in hubspot.ts, since labeling is
// a display concern specific to this logging path.
const QUALIFICATION_ANSWER_LABELS: Record<string, string> = {
  monthly_budget: 'Monthly Budget',
  monthly_marketing_spend: 'Monthly Marketing Spend',
  dream_patient: 'Dream Patient',
  practice_overview: 'Practice Overview',
  practice_stage: 'Practice Stage',
  past_agency_experience: 'Past Agency Experience',
  past_agency_count: 'Past Agency Count',
  past_experience_details: 'Past Experience Details',
  vision_for_success: 'Vision For Success',
  magic_wand_answer: 'Magic Wand Answer',
  growth_priorities: 'Growth Priorities',
  open_to_paid_ads: 'Open To Paid Ads',
  social_media_handler: 'Social Media Handler',
  current_marketing: 'Current Marketing',
};

// The exact HubSpot form name this detects, read from
// `recent_conversion_event_name` on the contact — matched by name
// because HubSpot's CRM webhooks don't expose a distinct "which form"
// event type, only generic property-change events (see
// hubspot-webhook-receiver's header comment). Fragile if the form is
// ever renamed in HubSpot; if submissions stop showing up in a lead's
// history, check this string against the live form's name first.
const QUALIFICATION_FORM_EVENT_NAME = 'Form: Discovery Qualification Form';

// Writes a distinct, dated "Qualification form submitted" comm_log
// entry the first time hubspot-webhook-receiver sees a NEW Discovery
// Qualification Form submission on this contact — as opposed to
// silently absorbing the answers into leads-table gap-filling with no
// visible record, which is what happened before this existed (see
// hubspot-webhook-receiver's header comment and DEPLOYMENT.md for the
// full investigation this was built from).
//
// Idempotency: HubSpot's `recent_conversion_event_name` stays set to
// the form's name for every subsequent property-change event on this
// contact, not just the one that fired at submission time — so this
// compares `recent_conversion_date` against
// leads.last_qualification_form_submission_at and only logs once per
// actual new submission (a real re-submission produces a newer
// recent_conversion_date and gets logged again; an unrelated edit to
// the same contact does not).
export async function maybeLogQualificationFormSubmission(
  supabaseAdmin: any,
  leadId: string,
  hubspotContact: any
): Promise<void> {
  const props = hubspotContact?.properties || {};
  if (props.recent_conversion_event_name !== QUALIFICATION_FORM_EVENT_NAME) return;
  if (!props.recent_conversion_date) return;

  const submittedAt = new Date(props.recent_conversion_date);
  const { data: lead } = await supabaseAdmin
    .from('leads')
    .select('last_qualification_form_submission_at')
    .eq('id', leadId)
    .maybeSingle();
  const alreadyLoggedAt = lead?.last_qualification_form_submission_at
    ? new Date(lead.last_qualification_form_submission_at)
    : null;
  if (alreadyLoggedAt && submittedAt <= alreadyLoggedAt) return;

  const answerLines = DISCOVERY_QUALIFICATION_FORM_PROPERTIES
    .filter((key) => props[key] != null && String(props[key]).trim() !== '')
    .map((key) => `${QUALIFICATION_ANSWER_LABELS[key] || key}: ${props[key]}`);

  await supabaseAdmin.from('comm_log').insert([{
    lead_id: leadId,
    type: 'qualification_form_submission',
    subject: 'Qualification form submitted',
    content: answerLines.length ? answerLines.join('\n') : '(No answers were on the submitted contact record.)',
    sent_at: submittedAt.toISOString(),
  }]);

  await supabaseAdmin
    .from('leads')
    .update({ last_qualification_form_submission_at: submittedAt.toISOString() })
    .eq('id', leadId);
}

const HUBSPOT_PIPELINE_GROUP_NAME = 'HubSpot Leads';

// Looks up the "HubSpot Leads" pipeline_groups.id for defaulting new,
// non-Monday-sourced leads onto it (see schema v21). Failure (table
// not migrated yet, no matching row) is logged and swallowed, not
// thrown — a missing pipeline group must never block lead creation
// itself, it just leaves pipeline_group_id null for that row, the
// same state every lead was already in before v21.
async function getHubspotLeadsGroupId(supabaseAdmin: any): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('pipeline_groups')
      .select('id')
      .eq('name', HUBSPOT_PIPELINE_GROUP_NAME)
      .maybeSingle();
    if (error || !data) {
      console.warn(`Could not resolve "${HUBSPOT_PIPELINE_GROUP_NAME}" pipeline group (has schema v21 run?): ${error?.message || 'no matching row'}`);
      return null;
    }
    return data.id;
  } catch (e) {
    console.warn(`pipeline_groups lookup threw: ${(e as Error).message}`);
    return null;
  }
}

// Upserts a leads row from a HubSpot Contact record (as returned by
// getHubspotContactById). If a matching lead already exists, only fills
// in hubspot_contact_id / company_id when those are currently null —
// everything else on the existing row is left exactly as it was.
export async function upsertLeadFromHubspotContact(
  supabaseAdmin: any,
  hubspotContact: any,
  companyId?: string | null
): Promise<{ id: string; created: boolean }> {
  const hubspotContactId = String(hubspotContact.id);
  const props = hubspotContact.properties || {};
  const email = (props.email || '').trim();

  const existing = await findLeadByHubspotIdOrEmail(supabaseAdmin, hubspotContactId, email || null);

  if (existing) {
    const updates: Record<string, unknown> = {};
    if (!existing.hubspot_contact_id) updates.hubspot_contact_id = hubspotContactId;
    if (companyId && !existing.company_id) updates.company_id = companyId;
    if (Object.keys(updates).length) {
      await supabaseAdmin.from('leads').update(updates).eq('id', existing.id);
    }
    return { id: existing.id, created: false };
  }

  const contactName = `${props.firstname || ''} ${props.lastname || ''}`.trim();
  const pipelineGroupId = await getHubspotLeadsGroupId(supabaseAdmin);
  const { data: inserted, error } = await supabaseAdmin
    .from('leads')
    .insert([{
      contact_name: contactName || null,
      email: email || null,
      business_name: props.company || null,
      hubspot_contact_id: hubspotContactId,
      company_id: companyId || null,
      source: 'HubSpot',
      stage: 'New Lead',
      pipeline_group_id: pipelineGroupId,
    }])
    .select('id')
    .single();
  if (error || !inserted) throw new Error(`Could not create lead for HubSpot contact ${hubspotContactId}: ${error?.message}`);
  return { id: inserted.id, created: true };
}
