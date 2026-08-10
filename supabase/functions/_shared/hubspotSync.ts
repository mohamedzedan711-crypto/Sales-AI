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
    }])
    .select('id')
    .single();
  if (error || !inserted) throw new Error(`Could not create lead for HubSpot contact ${hubspotContactId}: ${error?.message}`);
  return { id: inserted.id, created: true };
}
