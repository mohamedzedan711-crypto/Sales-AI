// Google redirects here after the admin approves (or denies) access.
// Validates the state token (CSRF protection), exchanges the code for a
// refresh token, looks up which Gmail account was just connected, stores
// it in api_credentials, and bounces the browser back to the app.
//
// This must be registered exactly as an Authorized redirect URI in the
// Google Cloud OAuth client: {SUPABASE_URL}/functions/v1/gmail-oauth-callback

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { corsHeaders } from '../_shared/cors.ts';

function redirectToApp(status: 'connected' | 'error', message?: string): Response {
  const base = (Deno.env.get('QUESTIONNAIRE_BASE_URL') || '').replace(/\/$/, '');
  const url = `${base}/index.html?gmail=${status}${message ? '&gmail_msg=' + encodeURIComponent(message) : ''}`;
  return new Response(null, { status: 302, headers: { Location: url } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');

    if (oauthError) return redirectToApp('error', oauthError);
    if (!code || !state) return redirectToApp('error', 'Missing code or state from Google');

    const supabaseAdmin = getSupabaseAdmin();

    const { data: stateRow } = await supabaseAdmin.from('oauth_states').select('*').eq('state', state).maybeSingle();
    if (!stateRow) return redirectToApp('error', 'Invalid or expired connection attempt — try again');
    await supabaseAdmin.from('oauth_states').delete().eq('state', state);

    const clientId = Deno.env.get('GMAIL_CLIENT_ID')!;
    const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET')!;
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const redirectUri = `${supabaseUrl}/functions/v1/gmail-oauth-callback`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.refresh_token) {
      return redirectToApp(
        'error',
        tokenData.error_description || 'Google did not return a refresh token — disconnect and try again'
      );
    }

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();

    await supabaseAdmin.from('api_credentials').upsert({
      key_name: 'gmail',
      key_value: tokenData.refresh_token,
      meta: { email: profile.email || null },
      status: 'connected',
      connected_at: new Date().toISOString(),
    });

    return redirectToApp('connected');
  } catch (e) {
    return redirectToApp('error', String(e));
  }
});
