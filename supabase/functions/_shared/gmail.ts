// Sends and reads mail as Mary via the Gmail API.
//
// GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET identify the OAuth *app* itself
// (registered once in Google Cloud Console, redirect URI and all) — that's
// infrastructure, not a per-user credential, so it stays as a true
// Supabase secret. The refresh token and connected account's email are
// per-connection and come from the Connect Gmail flow (see
// gmail-oauth-callback), stored in api_credentials — callers resolve
// those via _shared/credentials.ts and pass them in here.

async function getAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('GMAIL_CLIENT_ID')!;
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET')!;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Failed to refresh Gmail access token: ' + JSON.stringify(data));
  return data.access_token;
}

function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sendGmail(refreshToken: string, senderEmail: string, to: string, subject: string, bodyText: string): Promise<void> {
  const accessToken = await getAccessToken(refreshToken);
  const raw = [
    `From: Mary Robb <${senderEmail}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    bodyText,
  ].join('\r\n');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: base64UrlEncode(raw) }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Gmail send failed: ' + err);
  }
}

// Returns full message objects (payload included) matching a Gmail search query.
export async function listGmailReplies(refreshToken: string, query: string): Promise<any[]> {
  const accessToken = await getAccessToken(refreshToken);
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const listData = await listRes.json();
  if (!listRes.ok) throw new Error('Gmail list failed: ' + JSON.stringify(listData));

  const messages = listData.messages || [];
  const full: any[] = [];
  for (const m of messages) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (msgRes.ok) full.push(await msgRes.json());
  }
  return full;
}
