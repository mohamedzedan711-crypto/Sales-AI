// Removes a stored credential (used by the Disconnect buttons, including
// Gmail's). Admin-gated, same as save-credential.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { verifyAdminPassword } from '../_shared/credentials.ts';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { key_name, admin_password } = await req.json();

    if (!verifyAdminPassword(admin_password)) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid admin password' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!key_name) throw new Error('key_name is required');

    const supabaseAdmin = getSupabaseAdmin();
    await supabaseAdmin.from('api_credentials').delete().eq('key_name', key_name);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
