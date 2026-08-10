// key is resolved by the caller via _shared/credentials.ts
// (api_credentials table, key_name 'hubspot') — never from Deno.env.
export async function getHubspotContacts(key: string): Promise<any[]> {
  const res = await fetch(
    'https://api.hubapi.com/crm/v3/objects/contacts?limit=100&properties=firstname,lastname,email,phone,company,hs_lead_status,hs_analytics_source',
    { headers: { Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) throw new Error('HubSpot returned ' + res.status);
  const data = await res.json();
  return data.results || [];
}

// Logs a note against a HubSpot contact (and best-effort against the deal,
// if one is provided). Used by the notetaker automation to push extracted
// call info into HubSpot instead of only appending to our own comm_log.
//
// associationTypeId 202 (note-to-contact) is the value HubSpot's own docs
// use as the default — same one already proven working elsewhere in this
// app's client-side HUBSPOT.logCall. associationTypeId 214 (note-to-deal)
// is a best-effort guess, not independently verified — wrapped so a wrong
// value here can't break the contact note, which is the reliable part.
export async function createHubspotNote(
  key: string,
  contactId: string,
  dealId: string | null,
  noteBody: string
): Promise<void> {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { hs_note_body: noteBody, hs_timestamp: new Date().toISOString() },
      associations: [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
      }],
    }),
  });
  if (!res.ok) throw new Error('HubSpot note creation failed: ' + (await res.text()));

  if (dealId) {
    try {
      const created = await res.json();
      const noteId = created.id;
      if (noteId) {
        await fetch(`https://api.hubapi.com/crm/v4/objects/notes/${noteId}/associations/deals/${dealId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }]),
        });
      }
    } catch {
      // Best-effort only — the contact note above already succeeded, which is what matters.
    }
  }
}

// Fetches a single Contact/Company by id — used by hubspot-webhook-receiver
// to pull the full record after a webhook only tells us an objectId changed.
// The exact custom fields the live "Discovery Qualification Form" writes
// to a contact on submission — confirmed against real submitted
// contacts in the connected HubSpot portal (not guessed). Exported so
// hubspotSync.ts's submission-detection logic can build a readable
// summary from whichever of these are actually present, without a
// second source of truth for the field list.
export const DISCOVERY_QUALIFICATION_FORM_PROPERTIES = [
  'monthly_budget', 'monthly_marketing_spend', 'dream_patient', 'practice_overview',
  'practice_stage', 'past_agency_experience', 'past_agency_count', 'past_experience_details',
  'vision_for_success', 'magic_wand_answer', 'growth_priorities', 'open_to_paid_ads',
  'social_media_handler', 'current_marketing',
];

export async function getHubspotContactById(key: string, contactId: string): Promise<any> {
  const properties = [
    'email', 'firstname', 'lastname', 'company', 'phone', 'hs_lead_status', 'hs_analytics_source',
    'createdate', 'lastmodifieddate',
    // recent_conversion_event_name/date is how a form submission is
    // detected at all (see hubspotSync.ts) — without these two, a
    // submission on the Discovery Qualification Form is indistinguishable
    // from any other property edit once it reaches this function.
    'recent_conversion_event_name', 'recent_conversion_date',
    ...DISCOVERY_QUALIFICATION_FORM_PROPERTIES,
  ].join(',');
  const res = await fetch(
    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}?properties=${properties}`,
    { headers: { Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) throw new Error('HubSpot getHubspotContactById returned ' + res.status);
  return res.json();
}

export async function getHubspotCompanyById(key: string, companyId: string): Promise<any> {
  const res = await fetch(
    `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=name,domain,city,state,industry,createdate,hs_lastmodifieddate`,
    { headers: { Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) throw new Error('HubSpot getHubspotCompanyById returned ' + res.status);
  return res.json();
}

// Returns the first associated company id for a contact, or null if none.
// HubSpot's default association allows more than one, but this app treats
// a lead as having a single practice — first result is what we use.
export async function getAssociatedCompanyId(key: string, contactId: string): Promise<string | null> {
  const res = await fetch(
    `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/companies`,
    { headers: { Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) throw new Error('HubSpot getAssociatedCompanyId returned ' + res.status);
  const data = await res.json();
  return data.results?.[0]?.toObjectId != null ? String(data.results[0].toObjectId) : null;
}

// Returns every contact id associated with a company (a company changing
// can affect multiple contacts/leads).
export async function getAssociatedContactIds(key: string, companyId: string): Promise<string[]> {
  const res = await fetch(
    `https://api.hubapi.com/crm/v4/objects/companies/${companyId}/associations/contacts`,
    { headers: { Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) throw new Error('HubSpot getAssociatedContactIds returned ' + res.status);
  const data = await res.json();
  return (data.results || []).map((r: any) => String(r.toObjectId));
}

// CONTAINS_TOKEN search against Company `name` — HubSpot tokenizes both
// the stored property value and the search value and matches on token
// overlap, so passing the whole extracted name string as `value` is the
// normal way to use this operator (no need to loop token-by-token
// ourselves). Used by prospero-webhook-receiver's fuzzy company matching
// — there is no prior implementation of this in the codebase to reuse;
// this is a new, from-scratch use of a real, documented HubSpot Search
// API operator.
export async function searchHubspotCompaniesByName(key: string, nameQuery: string, limit = 5): Promise<any[]> {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: nameQuery }] }],
      properties: ['name', 'domain'],
      limit,
    }),
  });
  if (!res.ok) throw new Error('HubSpot searchHubspotCompaniesByName returned ' + res.status);
  const data = await res.json();
  return data.results || [];
}

// Creates a new Deal, or updates one if hubspotDealId is provided (pass
// the id already stored on our own deals.hubspot_deal_id). Association
// type IDs below (deal-to-contact: 3, deal-to-company: 5) are HubSpot's
// documented defaults — same caveat already on createHubspotNote's
// note-to-deal association above: not independently re-verified against
// a live account in this pass. Wrapped so a wrong association id can't
// break the deal write itself, which is the reliable part.
export async function upsertHubspotDeal(
  key: string,
  hubspotDealId: string | null,
  properties: Record<string, string | number>,
  associations: { contactId?: string | null; companyId?: string | null }
): Promise<string> {
  const url = hubspotDealId
    ? `https://api.hubapi.com/crm/v3/objects/deals/${hubspotDealId}`
    : 'https://api.hubapi.com/crm/v3/objects/deals';
  const res = await fetch(url, {
    method: hubspotDealId ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) throw new Error('HubSpot upsertHubspotDeal failed: ' + (await res.text()));
  const saved = await res.json();
  const dealId = saved.id;

  if (associations.contactId) {
    try {
      await fetch(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/contacts/${associations.contactId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]),
      });
    } catch {
      // Best-effort only — the deal itself already saved, which is what matters.
    }
  }
  if (associations.companyId) {
    try {
      await fetch(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/companies/${associations.companyId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 }]),
      });
    } catch {
      // Best-effort only.
    }
  }

  return dealId;
}
