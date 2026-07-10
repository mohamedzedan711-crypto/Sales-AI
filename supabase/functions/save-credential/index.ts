// Called from Settings > Integrations when the admin saves an Anthropic,
// HubSpot, or Read.ai key. Runs a lightweight live test call before ever
// marking the key "connected" — a key that doesn't actually work is
// stored as "invalid" instead, so the badge never lies.
//
// Gated behind an admin password (ADMIN_PANEL_PASSWORD secret) — this is
// the only way api_credentials ever gets written to from outside an
// Edge Function; there is no direct table insert from the browser.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { verifyAdminPassword } from '../_shared/credentials.ts';
import { corsHeaders } from '../_shared/cors.ts';

const TESTABLE_KEYS = ['anthropic', 'hubspot', 'readai'];

async function testKey(keyName: string, keyValue: string): Promise<boolean> {
  try {
    if (keyName === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': keyValue,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      return res.ok;
    }
    if (keyName === 'hubspot') {
      const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
        headers: { Authorization: `Bearer ${keyValue}` },
      });
      return res.ok;
    }
    if (keyName === 'readai') {
      const res = await fetch('https://api.read.ai/v1/sessions?limit=1', {
        headers: { Authorization: `Bearer ${keyValue}` },
      });
      return res.ok;
    }
    return false;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { key_name, key_value, admin_password } = await req.json();

    if (!verifyAdminPassword(admin_password)) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid admin password' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!TESTABLE_KEYS.includes(key_name)) {
      return new Response(JSON.stringify({ ok: false, error: `Unknown key_name: ${key_name}` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!key_value) {
      return new Response(JSON.stringify({ ok: false, error: 'key_value is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const works = await testKey(key_name, key_value);
    const supabaseAdmin = getSupabaseAdmin();
    await supabaseAdmin.from('api_credentials').upsert({
      key_name,
      key_value,
      status: works ? 'connected' : 'invalid',
      connected_at: works ? new Date().toISOString() : null,
    });

    return new Response(JSON.stringify({ ok: true, status: works ? 'connected' : 'invalid' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
