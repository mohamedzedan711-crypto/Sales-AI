// Resolves per-service API credentials from the api_credentials table
// (never from Deno.env — see supabase_schema_v3.sql for why RLS locks
// that table out of the anon key entirely) and gates the admin-only
// write endpoints (save-credential, disconnect-credential,
// gmail-oauth-start) behind a shared password.

export async function getCredential(
  supabaseAdmin: any,
  keyName: string
): Promise<{ value: string; meta: any } | null> {
  const { data, error } = await supabaseAdmin
    .from('api_credentials')
    .select('key_value, meta, status')
    .eq('key_name', keyName)
    .maybeSingle();
  if (error || !data || !data.key_value || data.status !== 'connected') return null;
  return { value: data.key_value, meta: data.meta || {} };
}

// Same as getCredential, but throws a clear, user-facing error instead of
// returning null — use this in the automation functions so a missing key
// fails gracefully ("HubSpot not connected...") rather than crashing.
export async function requireCredential(
  supabaseAdmin: any,
  keyName: string,
  label: string
): Promise<{ value: string; meta: any }> {
  const cred = await getCredential(supabaseAdmin, keyName);
  if (!cred) throw new Error(`${label} not connected — add your API key in Settings.`);
  return cred;
}

export function verifyAdminPassword(providedPassword: string | undefined | null): boolean {
  const actual = Deno.env.get('ADMIN_PANEL_PASSWORD');
  if (!actual) return false; // fail closed if the operator never set one
  return !!providedPassword && providedPassword === actual;
}
