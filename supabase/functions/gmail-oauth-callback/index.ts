// Google redirects here after the admin approves (or denies) access.
// Validates the state token (CSRF protection), exchanges the code for a
// refresh token, looks up which Gmail account was just connected, stores
// it in api_credentials, and sends the browser back to the app.
//
// This must be registered exactly as an Authorized redirect URI in the
// Google Cloud OAuth client: {SUPABASE_URL}/functions/v1/gmail-oauth-callback
//
// index.html is now hosted at APP_BASE_URL, so on success this redirects
// straight to Settings with ?gmail=connected — index.html's own
// handleGmailOAuthRedirect() picks that up and shows the confirmation
// toast. The inline HTML page below is kept only as a fallback for the
// (essentially theoretical) case where building/returning that redirect
// itself throws.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { corsHeaders } from '../_shared/cors.ts';

const APP_BASE_URL = 'https://sales-ai-ten-xi.vercel.app';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}

function redirectToApp(status: 'connected' | 'error', message?: string): Response {
  const url = `${APP_BASE_URL}/index.html?gmail=${status}${message ? '&gmail_msg=' + encodeURIComponent(message) : ''}`;
  return new Response(null, { status: 302, headers: { Location: url } });
}

function confirmationPage(status: 'connected' | 'error', message?: string): Response {
  const ok = status === 'connected';
  const heading = ok ? 'Gmail Connected' : 'Connection Failed';
  const body = ok
    ? 'Gmail connected successfully. You can close this tab and return to the app — check Settings → Integrations to confirm.'
    : escapeHtml(message || 'Something went wrong connecting Gmail. Close this tab, return to the app, and try again.');
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading} — Social Practice AI</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;background:#1a1a2e;color:#fff;margin:0;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;}
  .card{background:#22223a;padding:40px 36px;border-radius:16px;max-width:420px;margin:20px;}
  .icon{font-size:34px;margin-bottom:12px;}
  h1{color:${ok ? '#e91e8c' : '#ff6b81'};font-size:19px;margin:0 0 12px;}
  p{color:#c9c9d9;font-size:14px;line-height:1.6;margin:0;}
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${ok ? '✅' : '⚠️'}</div>
    <h1>${heading}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');

    if (oauthError) return confirmationPage('error', oauthError);
    if (!code || !state) return confirmationPage('error', 'Missing code or state from Google');

    const supabaseAdmin = getSupabaseAdmin();

    const { data: stateRow } = await supabaseAdmin.from('oauth_states').select('*').eq('state', state).maybeSingle();
    if (!stateRow) return confirmationPage('error', 'Invalid or expired connection attempt — try again');
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
      return confirmationPage(
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

    try {
      return redirectToApp('connected');
    } catch {
      // Redirect construction/return itself failed — fall back to the inline page so the user still sees a clear result.
      return confirmationPage('connected');
    }
  } catch (e) {
    return confirmationPage('error', String(e));
  }
});
