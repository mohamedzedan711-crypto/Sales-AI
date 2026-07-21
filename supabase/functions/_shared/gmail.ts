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

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Turns a plain-text email body (the kind every caller here already builds,
// from a Claude draft or plain string concatenation) into safe, minimal
// HTML: escapes special characters, then converts newlines to <br> so
// paragraphs/line breaks actually render instead of collapsing into one
// wall of text. Deliberately no template, styling, or logo — that's held
// for later once Mary's brand assets are available. Callers that need a
// real hyperlink build it in themselves (see send-questionnaire-email's
// marker substitution) after calling this, since escapeHtml above would
// otherwise mangle a literal <a> tag if it were escaped too.
export function textToHtmlBody(text: string): string {
  return escapeHtml(text).replace(/\r\n|\n/g, '<br>\n');
}

// The exact marker callers should instruct Claude to use in place of a raw
// URL — see bodyWithLink below for why.
export const LINK_MARKER = '[click here]';

// For drafted emails that reference a link (the questionnaire link, so
// far) — asking Claude to paste a raw URL into a plain-text-style draft is
// fragile and renders as an ugly auto-linkified string rather than a clean
// hyperlink. Instead, the drafting prompt tells Claude to write the
// LINK_MARKER inline (e.g. "Please [click here] to fill out the form"),
// and this swaps it for a real anchor tag after escaping the rest of the
// body. If Claude ignores the instruction and the marker never shows up,
// the link is appended as a fallback sentence instead of silently dropped.
export function bodyWithLink(text: string, link: string): string {
  const anchor = `<a href="${link}">click here</a>`;
  const html = textToHtmlBody(text);
  return html.includes(LINK_MARKER)
    ? html.replace(LINK_MARKER, anchor)
    : `${html}<br><br>You can also ${anchor} to get started.`;
}

// sendGmail's last argument is HTML, not plain text — every caller must
// pass a body already run through textToHtmlBody (or otherwise built as
// safe HTML), never a raw draft string.
export async function sendGmail(refreshToken: string, senderEmail: string, to: string, subject: string, htmlBody: string): Promise<void> {
  const accessToken = await getAccessToken(refreshToken);
  const raw = [
    `From: Mary Robb <${senderEmail}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    htmlBody,
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
