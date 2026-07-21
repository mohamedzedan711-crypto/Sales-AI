// Reports which known API keys are set as Supabase secrets (Deno.env),
// independent of anything pasted into api_credentials via Settings. This
// lets a key set once as a real Supabase secret "just work" everywhere —
// file://, localhost, the live Vercel URL — without needing to be re-pasted
// into the browser on every origin (localStorage is origin-scoped, secrets
// aren't). Never returns an actual key value, only true/false per service.
//
// Add a new service by adding one line to SERVICE_ENV_VARS below — the
// key on the left is the same key_name used in api_credentials / the
// Integrations panel, so both systems stay in sync by name.

import { corsHeaders } from '../_shared/cors.ts';

const SERVICE_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  hubspot: 'HUBSPOT_API_KEY',
  readai: 'READAI_API_KEY',
  fathom: 'FATHOM_API_KEY',
  monday: 'MONDAY_API_KEY',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const secrets: Record<string, boolean> = {};
    for (const [service, envVar] of Object.entries(SERVICE_ENV_VARS)) {
      secrets[service] = !!Deno.env.get(envVar);
    }
    return new Response(JSON.stringify({ ok: true, secrets }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
