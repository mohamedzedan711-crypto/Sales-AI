// Structured-only pre-call brief: built entirely from data already in the
// system (questionnaire answers, lead/pipeline record, qualification score,
// recent communications, and — if available — Read.ai's own summary/action
// items for this lead's most recent meeting). No LLM call — this is a
// templated document, not generated prose. Used by both
// generate-meeting-brief (client-triggered) and send-booking-email
// (auto-triggered right after a meeting is booked through the
// qualification funnel), so the logic lives here once rather than twice.

import { getCredential } from './credentials.ts';

interface ReadaiMeetingSummary {
  summary: string;
  actionItems: string[];
}

// Best-effort, same unverified-endpoint caveat as pull-transcripts.ts's own
// Read.ai integration (see that file's header comment) — adjust the field
// names below once the real Read.ai response shape is confirmed. This is
// its own lookup rather than a reuse of pull-transcripts.ts's internal
// fetchReadaiSessions, since that file is intentionally left untouched.
async function findReadaiSummaryForLead(readaiKey: string, leadEmail: string): Promise<ReadaiMeetingSummary | null> {
  const res = await fetch('https://api.read.ai/v1/sessions?limit=25', {
    headers: { Authorization: `Bearer ${readaiKey}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const sessions = data.sessions || data.results || data.items || [];
  const match = sessions.find(
    (s: any) => (s.attendees?.[0]?.email || s.participant_email || '').toLowerCase() === leadEmail.toLowerCase()
  );
  if (!match) return null;
  return {
    summary: match.summary || match.session_summary || '',
    actionItems: match.action_items || match.actionItems || [],
  };
}

function bulletList(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join('\n') : '- None on file.';
}

export async function generateMeetingPrepBrief(supabaseAdmin: any, leadId: string): Promise<string> {
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

  let readaiSummary: ReadaiMeetingSummary | null = null;
  if (lead.email) {
    const readaiCred = await getCredential(supabaseAdmin, 'readai');
    if (readaiCred) {
      try { readaiSummary = await findReadaiSummaryForLead(readaiCred.value, lead.email); }
      catch { /* best-effort — brief still generates without it */ }
    }
  }

  const qualificationLine = lead.qualified === true
    ? `Qualified (score ${lead.qualification_score ?? 'n/a'}) — ${lead.qualification_reason || 'n/a'}`
    : lead.qualified === false
      ? `Not qualified — ${lead.qualification_reason || 'n/a'}`
      : 'Not yet scored';

  const commLines = (comms || []).map((c: any) => `[${c.type}] ${c.subject || ''} (${c.sent_at})`);

  const sections = [
    `MEETING PREP BRIEF — ${lead.business_name || 'Unknown practice'}`,
    '',
    'LEAD',
    `- Contact: ${lead.contact_name || 'Unknown'}`,
    `- Practice type: ${lead.practice_type || 'n/a'}`,
    `- Location: ${lead.location || 'n/a'}`,
    `- Stage: ${lead.stage || 'n/a'}`,
    '',
    'QUALIFICATION',
    `- ${qualificationLine}`,
    '',
    'QUESTIONNAIRE ANSWERS',
    questionnaire
      ? bulletList([
          `Current marketing setup: ${questionnaire.current_marketing_setup || 'n/a'}`,
          `Monthly new-client volume: ${questionnaire.monthly_new_client_volume || 'n/a'}`,
          `Who approves spend: ${questionnaire.approves_spend || 'n/a'}`,
          `Monthly budget band: ${questionnaire.monthly_budget_band || 'n/a'}`,
          `Biggest challenge: ${questionnaire.biggest_challenge || 'n/a'}`,
          `6-12 month goal: ${questionnaire.six_month_goal || 'n/a'}`,
          `Start timeline: ${questionnaire.start_timeline || 'n/a'}`,
        ])
      : '- Not submitted yet.',
    '',
    'RECENT COMMUNICATIONS',
    bulletList(commLines),
    '',
    'READ.AI MEETING SUMMARY',
    ...(readaiSummary
      ? [
          readaiSummary.summary ? `- ${readaiSummary.summary}` : '- No summary text on file.',
          ...(readaiSummary.actionItems.length ? ['', 'ACTION ITEMS', bulletList(readaiSummary.actionItems)] : []),
        ]
      : ['- No Read.ai summary available for this meeting yet.']),
    '',
    'NOTES ON FILE',
    `- ${lead.notes || 'None.'}`,
  ];

  const brief = sections.join('\n');

  await supabaseAdmin
    .from('leads')
    .update({ meeting_prep_brief: brief, meeting_prep_generated_at: new Date().toISOString() })
    .eq('id', leadId);

  return brief;
}
