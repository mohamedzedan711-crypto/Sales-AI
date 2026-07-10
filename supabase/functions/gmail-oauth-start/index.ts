// Called when the admin clicks "Connect Gmail" in Settings. Admin-gated,
// same as save-credential. Returns the Google consent URL for the browser
// to redirect to; gmail-oauth-callback handles what Google sends back.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { verifyAdminPassword } from '../_shared/credentials.ts';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { admin_password } = await req.json();
    if (!verifyAdminPassword(admin_password)) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid admin password' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const clientId = Deno.env.get('GMAIL_CLIENT_ID');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!clientId || !supabaseUrl) throw new Error('GMAIL_CLIENT_ID or SUPABASE_URL is not configured');

    const state = crypto.randomUUID();
    const supabaseAdmin = getSupabaseAdmin();
    // Sweep stale (>10 min old) states, then record this one for the callback to verify.
    await supabaseAdmin
      .from('oauth_states')
      .delete()
      .lt('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());
    await supabaseAdmin.from('oauth_states').insert([{ state }]);

    const redirectUri = `${supabaseUrl}/functions/v1/gmail-oauth-callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent', // forces a refresh_token every time, not just first-ever auth
      scope: [
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
      ].join(' '),
      state,
    });

    return new Response(
      JSON.stringify({ ok: true, url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
