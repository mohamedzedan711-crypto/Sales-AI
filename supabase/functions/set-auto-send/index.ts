// Called from Settings when the admin toggles "Auto-Send / Auto-Respond".
// This is the ONLY way system_settings.auto_send_enabled can be changed —
// schema v9 removes the anon write policy on that table, so a direct
// Supabase client call from the browser can no longer flip it. Gated
// behind the same ADMIN_PANEL_PASSWORD used by save-credential /
// disconnect-credential / gmail-oauth-start, since this switch controls
// whether the entire system can send anything automatically.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { verifyAdminPassword } from '../_shared/credentials.ts';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { enabled, admin_password } = await req.json();

    if (!verifyAdminPassword(admin_password)) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid admin password' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (typeof enabled !== 'boolean') {
      return new Response(JSON.stringify({ ok: false, error: 'enabled (boolean) is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = getSupabaseAdmin();
    const { error } = await supabaseAdmin
      .from('system_settings')
      .upsert({ id: 1, auto_send_enabled: enabled, updated_at: new Date().toISOString() });
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, auto_send_enabled: enabled }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
