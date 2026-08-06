// Starts the Read.ai OAuth 2.1 authorization flow. SCAFFOLD ONLY — Read.ai
// client_id/client_secret don't exist yet, so READ_AI_CLIENT_ID /
// READ_AI_AUTH_URL / READ_AI_REDIRECT_URI are unset placeholders (see
// .env.example) until real values are set as Supabase secrets; this
// function throws a clear "not configured" error until then. No live
// call to Read.ai happens here or anywhere in this scaffold.
//
// Mirrors gmail-oauth-start's approach: a random `state` token is
// recorded in oauth_states (same table, same >10min stale-row sweep) for
// the callback to verify as CSRF protection. OAuth 2.1 additionally
// requires PKCE, so a code_verifier is generated here and stored
// alongside the state in oauth_states.code_verifier (schema v10) — the
// code_challenge derived from it is sent to Read.ai now; the raw
// code_verifier is sent to Read.ai later, by read-ai-oauth-callback, to
// prove this request and that callback came from the same place.
//
// Unlike gmail-oauth-start (a POST endpoint gated by admin_password,
// called via fetch from index.html's "Connect Gmail" button, which then
// navigates the browser itself), this is a plain GET endpoint that issues
// a real 302 redirect directly. There's no "Connect Read.ai" button wired
// up yet (out of scope for this pass) — nothing calls this function yet,
// so there was nothing to gate behind the admin password. Add an
// admin_password check here (matching gmail-oauth-start) before wiring up
// a frontend button, if you want the same convention for consistency.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { corsHeaders } from '../_shared/cors.ts';

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier(): string {
  // 32 random bytes -> 43-char base64url string, within PKCE's required
  // 43-128 char range (RFC 7636).
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const clientId = Deno.env.get('READ_AI_CLIENT_ID');
    const authUrl = Deno.env.get('READ_AI_AUTH_URL');
    const redirectUri = Deno.env.get('READ_AI_REDIRECT_URI');
    if (!clientId || !authUrl || !redirectUri) {
      throw new Error(
        'READ_AI_CLIENT_ID, READ_AI_AUTH_URL, and READ_AI_REDIRECT_URI must be set as Supabase secrets before this flow can run — see .env.example. Read.ai OAuth credentials do not exist yet, so this is expected for now.'
      );
    }

    const state = crypto.randomUUID();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const supabaseAdmin = getSupabaseAdmin();
    // Sweep stale (>10 min old) states, same convention as gmail-oauth-start.
    await supabaseAdmin
      .from('oauth_states')
      .delete()
      .lt('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());
    await supabaseAdmin.from('oauth_states').insert([{ state, code_verifier: codeVerifier }]);

    // TODO: PLACEHOLDER — Read.ai's actual required OAuth scope names are
    // unverified against official documentation or a live account. These
    // are a best-effort guess at plausible names, matching the same
    // "adjust once you have real API access" caveat already documented in
    // pull-transcripts.ts's Read.ai integration. Confirm and correct
    // before this flow is used for real.
    const scopes = ['read', 'meetings.read'];

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return new Response(null, {
      status: 302,
      headers: { ...corsHeaders, Location: `${authUrl}?${params.toString()}` },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
