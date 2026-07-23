// Mirrors index.html's buildSystemPrompt()/getVoiceProfileBlock() so every
// email drafted by the backend automation sounds the same as everything
// drafted from inside the app.

export async function getVoiceProfileBlock(supabaseAdmin: any): Promise<string> {
  const { data } = await supabaseAdmin.from('voice_profile').select('*').eq('id', 1).maybeSingle();
  const hasProfile = data && (data.tone_summary || (data.raw_samples && data.raw_samples.length));
  if (!hasProfile) {
    return 'No voice profile has been created yet in Settings. Flag this at the top of the draft instead of guessing at Mary\'s tone (e.g. "No voice profile on file yet — using a neutral professional tone.").';
  }
  return `Tone: ${data.tone_summary || 'n/a'}
Energy: ${data.energy_level || 'n/a'}
Formality: ${data.formality_level || 'n/a'}
Common openers: ${(data.common_openers || []).join('; ') || 'n/a'}
Common closers: ${(data.common_closers || []).join('; ') || 'n/a'}
Signature phrases: ${(data.signature_phrases || []).join('; ') || 'n/a'}
Never does: ${(data.never_does || []).join('; ') || 'n/a'}`;
}

export function buildSystemPrompt(roleInstructions: string, voiceBlock: string): string {
  return `You are an AI assistant embedded in the Social Practice Sales Engine used by Mary Robb, founder of Social Practice, a boutique social media marketing agency based in Dallas, TX serving the medical aesthetics industry (med spas, plastic surgery practices, cosmetic dentistry).

Write this in Mary's voice using the profile below. Match her tone, energy, formality, openers/closers, and phrasing. Do not sound generic or corporate. If no voice profile exists yet, flag that in the draft instead of guessing.
${voiceBlock}

${roleInstructions}

Rules:
- Never write generic, placeholder, or templated content. Always be specific to the exact context given.
- Never use bracket placeholders like [Name] or [Business]. Use the real details provided.
- Write like a real person, not a robot.
- Never use em dashes (—) or en dashes used as sentence connectors. Use periods, commas, or "and"/"but" instead.
- Avoid other AI-sounding patterns: no "I hope this finds you well," no triple-adjective lists, no overly symmetric sentence structures, no starting multiple sentences in a row with the same word.
- Write the way a busy, real person actually types, with a slightly imperfect rhythm, varied sentence length, and nothing that reads like polished editorial copy.`;
}
