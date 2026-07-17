// Structured-only pre-call brief: built entirely from data already in the
// system (questionnaire answers, lead/pipeline record, qualification
// score, recent communications) — no external web/social research. Used
// by both generate-meeting-brief (client-triggered) and send-booking-email
// (auto-triggered right after a meeting is booked through the
// qualification funnel), so the logic lives here once rather than twice.

import { callClaude } from './claude.ts';

export async function generateMeetingPrepBrief(
  supabaseAdmin: any,
  anthropicKey: string,
  leadId: string
): Promise<string> {
  const { data: lead } = await supabaseAdmin.from('leads').select('*').eq('id', leadId).maybeSingle();
  if (!lead) throw new Error('Lead not found');

  const { data: questionnaire } = await supabaseAdmin
    .from('questionnaire_responses')
    .select('*')
    .eq('lead_id', leadId)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: comms } = await supabaseAdmin
    .from('comm_log')
    .select('type, subject, sent_at')
    .eq('lead_id', leadId)
    .order('sent_at', { ascending: false })
    .limit(5);

  const qualificationLine = lead.qualified === true
    ? `Qualified (score ${lead.qualification_score ?? 'n/a'}) — ${lead.qualification_reason || 'n/a'}`
    : lead.qualified === false
      ? `Not qualified — ${lead.qualification_reason || 'n/a'}`
      : 'Not yet scored';

  const context = `Lead: ${lead.contact_name || 'Unknown'} from ${lead.business_name || 'Unknown practice'}
Practice type: ${lead.practice_type || 'n/a'}
Location: ${lead.location || 'n/a'}
Stage: ${lead.stage}
Qualification: ${qualificationLine}
Notes on file: ${lead.notes || 'None'}

Questionnaire answers: ${questionnaire ? JSON.stringify(questionnaire, null, 2) : 'Not submitted yet.'}

Recent communications (most recent first): ${(comms || []).map((c: any) => `- [${c.type}] ${c.subject || ''} (${c.sent_at})`).join('\n') || 'None on file.'}`;

  const brief = await callClaude(
    anthropicKey,
    'You are preparing a short pre-call brief for Mary Robb, founder of Social Practice, ahead of a strategy call with a prospect. Use ONLY the information given below — never invent details, and never do outside research. If something is not covered by the data given, say so rather than guessing.',
    `${context}\n\nWrite a concise pre-call brief (bullet points, under 200 words) covering: who they are and their practice, their stated pain points and goals, budget signal, any objections or concerns already surfaced, and 2-3 suggested talking points for the call.`,
    700
  );

  await supabaseAdmin.from('leads').update({
    meeting_prep_brief: brief,
    meeting_prep_generated_at: new Date().toISOString(),
  }).eq('id', leadId);

  return brief;
}
