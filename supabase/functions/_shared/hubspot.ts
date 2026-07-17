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
