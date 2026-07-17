const MODEL = 'claude-sonnet-4-6';

// apiKey is resolved by the caller via _shared/credentials.ts
// (api_credentials table, key_name 'anthropic') — never from Deno.env.
export async function callClaude(apiKey: string, systemPrompt: string, userContent: string, maxTokens = 1500): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error((data.error && data.error.message) || 'Claude request failed');
  }
  const text = (data.content || []).map((c: any) => c.text || '').join('\n').trim();
  return stripAiDashes(text);
}

// Belt-and-suspenders safety net: prompting alone doesn't guarantee Claude
// never slips an em dash in, so every response gets swept here too. Only
// touches em dashes and SPACED en dashes (a connector, e.g. "world — but")
// — a tight en dash with no surrounding spaces (a number range, e.g.
// "$1,000–$2,500/mo") is left alone. Not grammar-aware on purpose: picks
// a period before a capital letter, a comma otherwise.
function stripAiDashes(text: string): string {
  if (!text) return text;
  const replaceConnector = (match: string, offset: number, str: string) => {
    const after = str.slice(offset + match.length).trimStart();
    return /^[A-Z]/.test(after) ? '. ' : ', ';
  };
  return text
    .replace(/\s*—\s*/g, replaceConnector)
    .replace(/\s+–\s+/g, replaceConnector)
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function stripJsonFence(text: string): string {
  return text.replace(/```json/gi, '').replace(/```/g, '').trim();
}
