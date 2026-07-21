// Resolves per-service API credentials, preferring whatever's pasted into
// api_credentials (Settings -> Integrations) and falling back to a plain
// Supabase secret (Deno.env) with the matching name if nothing's pasted —
// see check-integration-status/index.ts for the key_name -> env var map.
// This means a key set once via `supabase secrets set` works immediately
// across every origin the app is opened from, no paste required; pasting
// one into Settings still overrides it, e.g. for quick local testing.
// Gates the admin-only write endpoints (save-credential,
// disconnect-credential, gmail-oauth-start) behind a shared password.

const ENV_FALLBACK_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  hubspot: 'HUBSPOT_API_KEY',
  readai: 'READAI_API_KEY',
  fathom: 'FATHOM_API_KEY',
  monday: 'MONDAY_API_KEY',
};

export async function getCredential(
  supabaseAdmin: any,
  keyName: string
): Promise<{ value: string; meta: any } | null> {
  const { data, error } = await supabaseAdmin
    .from('api_credentials')
    .select('key_value, meta, status')
    .eq('key_name', keyName)
    .maybeSingle();
  if (!error && data && data.key_value && data.status === 'connected') {
    return { value: data.key_value, meta: data.meta || {} };
  }

  const envVar = ENV_FALLBACK_VARS[keyName];
  const envValue = envVar ? Deno.env.get(envVar) : null;
  if (envValue) return { value: envValue, meta: {} };

  return null;
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
