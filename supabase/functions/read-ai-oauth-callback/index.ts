// Read.ai redirects here after the user approves (or denies) access.
// SCAFFOLD ONLY — READ_AI_CLIENT_SECRET / READ_AI_TOKEN_URL are unset
// placeholders (see .env.example) until real Read.ai OAuth credentials
// exist, so the token exchange below will fail with a clear
// "not configured" message until then. No live call to Read.ai happens
// as part of this scaffold.
//
// This must be registered exactly as the redirect URI in Read.ai's OAuth
// app config once client_id/client_secret exist — whatever
// READ_AI_REDIRECT_URI is set to (see .env.example). By convention,
// matching gmail-oauth-callback, that should be:
//   {SUPABASE_URL}/functions/v1/read-ai-oauth-callback
//
// Validates the state token (CSRF protection, same oauth_states table and
// validate-then-delete pattern as gmail-oauth-callback), retrieves the
// matching PKCE code_verifier stored by read-ai-authorize, exchanges the
// code for an access_token + refresh_token at Read.ai's token endpoint,
// and stores them in read_ai_tokens (schema v10). Single-connection
// model, same as Gmail: replaces whatever's stored rather than
// accumulating rows.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { corsHeaders } from '../_shared/cors.ts';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}

function confirmationPage(status: 'connected' | 'error', message?: string): Response {
  const ok = status === 'connected';
  const heading = ok ? 'Read.ai Connected' : 'Connection Failed';
  const body = ok
    ? 'Read.ai connected successfully. You can close this tab and return to the app.'
    : escapeHtml(message || 'Something went wrong connecting Read.ai. Close this tab, return to the app, and try again.');
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading} — Social Practice Sales Engine</title>
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
    if (!code || !state) return confirmationPage('error', 'Missing code or state from Read.ai');

    const supabaseAdmin = getSupabaseAdmin();

    const { data: stateRow } = await supabaseAdmin.from('oauth_states').select('*').eq('state', state).maybeSingle();
    if (!stateRow) return confirmationPage('error', 'Invalid or expired connection attempt — try again');
    await supabaseAdmin.from('oauth_states').delete().eq('state', state);

    const codeVerifier = stateRow.code_verifier;
    if (!codeVerifier) return confirmationPage('error', 'Missing PKCE code_verifier for this connection attempt — try again');

    const clientId = Deno.env.get('READ_AI_CLIENT_ID');
    const clientSecret = Deno.env.get('READ_AI_CLIENT_SECRET');
    const tokenUrl = Deno.env.get('READ_AI_TOKEN_URL');
    const redirectUri = Deno.env.get('READ_AI_REDIRECT_URI');
    if (!clientId || !clientSecret || !tokenUrl || !redirectUri) {
      return confirmationPage(
        'error',
        'Read.ai OAuth is not configured yet — READ_AI_CLIENT_ID, READ_AI_CLIENT_SECRET, READ_AI_TOKEN_URL, and READ_AI_REDIRECT_URI must be set as Supabase secrets first (see .env.example).'
      );
    }

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return confirmationPage(
        'error',
        tokenData.error_description || 'Read.ai did not return an access token — disconnect and try again'
      );
    }

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
      : null;

    // Single-connection model, same as Gmail's upsert-by-key_name: replace
    // whatever's stored rather than accumulating rows. read_ai_tokens uses
    // a real uuid pk (not a fixed singleton id like qualification_config),
    // so "replace" here means delete-then-insert rather than upsert.
    await supabaseAdmin.from('read_ai_tokens').delete().not('id', 'is', null);
    await supabaseAdmin.from('read_ai_tokens').insert([{
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }]);

    return confirmationPage('connected');
  } catch (e) {
    return confirmationPage('error', String(e));
  }
});
