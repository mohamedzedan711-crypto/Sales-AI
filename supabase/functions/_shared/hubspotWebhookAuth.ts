// HubSpot webhook v3 signature verification. SCAFFOLD, GATED ON PURPOSE —
// requires the HubSpot App's Client Secret (HUBSPOT_CLIENT_SECRET), a
// different credential than HUBSPOT_API_KEY (the private-app token used
// elsewhere in this codebase for our own outbound calls TO HubSpot).
// HUBSPOT_CLIENT_SECRET comes from registering an actual HubSpot App
// with a webhook subscription in HubSpot's developer settings — that
// App does not exist yet. Until HUBSPOT_CLIENT_SECRET is set as a
// Supabase secret, verifyHubspotSignatureV3 always fails closed and the
// receiver rejects every request. Same "throw/reject with a clear
// not-configured message until the real secret exists" pattern already
// used for the Read.ai OAuth scaffold.
//
// Algorithm per HubSpot's documented v3 webhook signature scheme:
//   base64(HMAC-SHA256(requestMethod + requestUri + requestBody + requestTimestamp, clientSecret))
// compared against the X-HubSpot-Signature-v3 header. X-HubSpot-Request-
// Timestamp must also be within 5 minutes of now, to reject replayed
// requests.
//
// CAVEAT: requestUri here is the full URL exactly as received (req.url).
// Exact-URI mismatches (scheme, trailing slash, query string ordering)
// are the most common real-world cause of "valid HubSpot event, invalid
// signature" — this has not been tested against a live HubSpot App yet
// since HUBSPOT_CLIENT_SECRET doesn't exist. Verify carefully against a
// real webhook delivery once it does, before trusting this in production.

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(signature);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export interface HubspotSignatureCheck {
  valid: boolean;
  reason?: string;
}

export async function verifyHubspotSignatureV3(
  method: string,
  fullUrl: string,
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null
): Promise<HubspotSignatureCheck> {
  const clientSecret = Deno.env.get('HUBSPOT_CLIENT_SECRET');
  if (!clientSecret) {
    return {
      valid: false,
      reason: 'HUBSPOT_CLIENT_SECRET is not set — register a HubSpot App with a webhook subscription and set this secret before this receiver can accept real events.',
    };
  }
  if (!signatureHeader || !timestampHeader) {
    return { valid: false, reason: 'Missing X-HubSpot-Signature-v3 or X-HubSpot-Request-Timestamp header.' };
  }

  const timestampMs = Number(timestampHeader);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_SKEW_MS) {
    return { valid: false, reason: 'X-HubSpot-Request-Timestamp is missing, invalid, or too old (possible replay) — rejected.' };
  }

  const sourceString = `${method}${fullUrl}${rawBody}${timestampHeader}`;
  const expected = await hmacSha256Base64(clientSecret, sourceString);

  console.log('[DEBUG-WEBHOOK-SIG]', JSON.stringify({ method: method, fullUrl: fullUrl, timestampHeader: timestampHeader, expected: expected, received: signatureHeader }));
  if (expected !== signatureHeader) {
    return { valid: false, reason: 'Signature mismatch — request does not appear to be from HubSpot.' };
  }
  return { valid: true };
}
