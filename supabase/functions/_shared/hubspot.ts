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
