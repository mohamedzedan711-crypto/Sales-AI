// Read.ai OAuth token management + API client scaffold. SCAFFOLD ONLY —
// no live Read.ai API calls happen anywhere in this module yet, and it
// makes zero calls to Anthropic/Claude or any other LLM. Mirrors
// _shared/gmail.ts's shape: a private getAccessToken-style refresh
// helper, exported functions for callers to use.
//
// Distinct from pull-transcripts.ts's existing Read.ai integration on
// purpose — that one uses a plain API key (via _shared/credentials.ts,
// api_credentials.key_name = 'readai') and is left untouched. This module
// is for the separate OAuth 2.1 connection being scaffolded here; nothing
// in pull-transcripts.ts imports or depends on this file.

import { getSupabaseAdmin } from './supabaseAdmin.ts';

interface ReadAiTokenRow {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
}

async function getTokenRow(supabaseAdmin: any): Promise<ReadAiTokenRow | null> {
  const { data } = await supabaseAdmin
    .from('read_ai_tokens')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function refreshAccessToken(supabaseAdmin: any, row: ReadAiTokenRow): Promise<string> {
  if (!row.refresh_token) {
    throw new Error('Read.ai is not connected — no refresh_token on file. Run the read-ai-authorize flow first.');
  }

  const clientId = Deno.env.get('READ_AI_CLIENT_ID');
  const clientSecret = Deno.env.get('READ_AI_CLIENT_SECRET');
  const tokenUrl = Deno.env.get('READ_AI_TOKEN_URL');
  if (!clientId || !clientSecret || !tokenUrl) {
    throw new Error(
      'READ_AI_CLIENT_ID, READ_AI_CLIENT_SECRET, and READ_AI_TOKEN_URL must be set as Supabase secrets before tokens can be refreshed — see .env.example.'
    );
  }

  const basicAuth = btoa(`${clientId}:${clientSecret}`);

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Failed to refresh Read.ai access token: ' + JSON.stringify(data));
  }

  const expiresAt = data.expires_in
    ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
    : null;

  await supabaseAdmin
    .from('read_ai_tokens')
    .update({
      access_token: data.access_token,
      // Some providers don't rotate the refresh token on every refresh —
      // keep the old one on file if a new one isn't returned.
      refresh_token: data.refresh_token || row.refresh_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);

  return data.access_token;
}

// Returns a valid access token, refreshing it first via refresh_token if
// it's missing or expired (60s safety margin). Throws a clear error if
// Read.ai has never been connected — see read-ai-authorize /
// read-ai-oauth-callback.
export async function getValidAccessToken(supabaseAdmin?: any): Promise<string> {
  const admin = supabaseAdmin || getSupabaseAdmin();
  const row = await getTokenRow(admin);
  if (!row) throw new Error('Read.ai is not connected — run the read-ai-authorize flow first.');

  const expiresAtMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  const stillValid = !!row.access_token && expiresAtMs > Date.now() + 60_000;
  if (stillValid) return row.access_token as string;

  return refreshAccessToken(admin, row);
}

// TODO: PLACEHOLDER — Read.ai's actual meeting-summary endpoint path and
// response shape are UNVERIFIED against official documentation or a live
// account. The path below is a literal placeholder, not a guess dressed
// up to look real — do not call this in production until the real path
// is confirmed and this TODO is replaced. Matches the same
// "best-effort, adjust once you have real API access" caveat already
// documented in pull-transcripts.ts's existing Read.ai integration.
export async function getMeetingSummary(meetingId: string): Promise<any> {
  const apiBase = Deno.env.get('READ_AI_API_BASE_URL');
  if (!apiBase) {
    throw new Error(
      'READ_AI_API_BASE_URL is not set (see .env.example) — and even once it is, this function is still a stub until the real endpoint path below is confirmed.'
    );
  }

  const accessToken = await getValidAccessToken();

  // TODO: REPLACE — not a real Read.ai endpoint. Confirm the actual path
  // against Read.ai's API docs (or a sample response from a live account)
  // before removing this TODO.
  const endpoint = `${apiBase}/TODO_REPLACE_WITH_REAL_MEETING_SUMMARY_PATH/${encodeURIComponent(meetingId)}`;

  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `Read.ai getMeetingSummary failed (${res.status}) — endpoint path is still a placeholder; confirm it against real API docs before treating this as a real failure.`
    );
  }
  return res.json();
}
