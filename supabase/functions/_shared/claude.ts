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
  return (data.content || []).map((c: any) => c.text || '').join('\n').trim();
}

export function stripJsonFence(text: string): string {
  return text.replace(/```json/gi, '').replace(/```/g, '').trim();
}
