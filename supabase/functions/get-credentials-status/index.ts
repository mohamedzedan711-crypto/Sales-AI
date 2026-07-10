// Read-only status for the Settings > Integrations badges. Never returns
// key_value — only status/connected_at/connected-account-email — so this
// one doesn't need the admin gate that writes require.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { corsHeaders } from '../_shared/cors.ts';

const KNOWN_KEYS = ['anthropic', 'hubspot', 'readai', 'gmail'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { data, error } = await supabaseAdmin
      .from('api_credentials')
      .select('key_name, status, connected_at, meta');
    if (error) throw error;

    const result: Record<string, any> = {};
    for (const row of data || []) {
      result[row.key_name] = {
        status: row.status || 'not_connected',
        connected_at: row.connected_at,
        email: row.meta?.email || null,
      };
    }
    for (const k of KNOWN_KEYS) {
      if (!result[k]) result[k] = { status: 'not_connected', connected_at: null, email: null };
    }

    return new Response(JSON.stringify({ ok: true, credentials: result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
