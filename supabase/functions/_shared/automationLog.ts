// Every function in this folder that's invoked by pg_cron or a Database
// Webhook runs unattended — nobody reads its HTTP response. Without this,
// a failure (bad lead match, expired credential, HubSpot API error) would
// only ever show up in Supabase's own function logs, invisible from inside
// the app. Call this anywhere one of those functions would otherwise fail
// silently (a best-effort catch, a skipped/no-match case) so it surfaces
// in Settings -> Integrations instead.

export async function logAutomationFailure(
  supabaseAdmin: any,
  automation: string,
  detail: string,
  leadId?: string | null
): Promise<void> {
  try {
    await supabaseAdmin.from('automation_failures').insert([{
      automation,
      detail,
      lead_id: leadId ?? null,
    }]);
  } catch {
    // If even logging the failure fails, there's nothing further this can do.
  }
}
