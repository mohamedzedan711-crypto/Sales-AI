// Global auto-send kill switch — one row in system_settings (schema v8),
// checked by every function that sends or triggers an automatic send
// (send-questionnaire-email, sync-hubspot-leads, send-booking-email,
// send-lead-email, and pull-transcripts' HubSpot note push). Defaults to
// false (fails closed) if the row is missing or the read errors, so a
// broken/unmigrated system_settings table never accidentally lets sends
// through.

export async function isAutoSendEnabled(supabaseAdmin: any): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('system_settings')
    .select('auto_send_enabled')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) return false;
  return !!data.auto_send_enabled;
}
