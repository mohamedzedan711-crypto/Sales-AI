// Pulls Read.ai's own meeting summaries and action items into matching
// leads' comm_log — separate from, and does not touch, pull-transcripts.ts
// (which pulls full transcripts via a plain API key through
// _shared/credentials.ts and is untouched by this file). No transcript
// text is fetched or stored here — only each meeting's summary and
// action_items.
//
// Uses _shared/readAiClient.ts's OAuth 2.1 connection (listRecentMeetings,
// getMeetingSummary), not api_credentials/getCredential like
// pull-transcripts.ts — these are two independent Read.ai connection
// paths by design; readAiClient.ts is not modified by this file beyond
// the one new listRecentMeetings export added alongside it.
//
// No LLM call anywhere in this file, no Anthropic/Claude import or
// reference.
//
// No HubSpot push in this pass — out of scope, unlike pull-transcripts.ts's
// notetaker-to-HubSpot step.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { listRecentMeetings, getMeetingSummary } from '../_shared/readAiClient.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

const LOOKBACK_MS = 48 * 60 * 60 * 1000; // ~48 hours

function collectCandidateEmails(meeting: any): string[] {
  const emails: string[] = [];
  for (const p of meeting.participants || []) {
    if (p?.email) emails.push(String(p.email).toLowerCase());
  }
  if (meeting.owner?.email) emails.push(String(meeting.owner.email).toLowerCase());
  return Array.from(new Set(emails));
}

// Checks every participant + owner email against leads.email (ilike),
// same matching approach as pull-transcripts.ts's lead-matching block,
// just against a list of candidate emails instead of a single one.
async function findLeadForMeeting(
  supabaseAdmin: any,
  meeting: any
): Promise<{ id: string; business_name: string; contact_name: string } | null> {
  for (const email of collectCandidateEmails(meeting)) {
    const { data: lead } = await supabaseAdmin
      .from('leads')
      .select('id, business_name, contact_name')
      .ilike('email', email)
      .maybeSingle();
    if (lead) return lead;
  }
  return null;
}

// Read.ai's action_items shape isn't fully confirmed — handle both a
// plain array of strings and an array of objects defensively rather than
// assuming one or the other.
function formatActionItems(actionItems: any): string[] {
  if (!Array.isArray(actionItems)) return [];
  return actionItems
    .map((item: any) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        return item.text || item.description || item.title || item.content || JSON.stringify(item);
      }
      return item != null ? String(item) : '';
    })
    .filter(Boolean);
}

function formatSummaryContent(meetingData: any, meeting: any): string {
  const title = meetingData?.title || meetingData?.name || meeting?.title || meeting?.name || 'Untitled meeting';
  const summary = meetingData?.summary || meetingData?.summary_text || 'No summary provided.';
  const actionItems = formatActionItems(meetingData?.action_items ?? meetingData?.actionItems);

  const lines = [`Meeting: ${title}`, `Summary: ${summary}`];
  if (actionItems.length) {
    lines.push('Action items:');
    for (const item of actionItems) lines.push(`- ${item}`);
  } else {
    lines.push('Action items: None on file.');
  }
  return lines.join('\n');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const sinceMs = Date.now() - LOOKBACK_MS;

    const meetings: any[] = [];
    const sourceErrors: string[] = [];
    try {
      meetings.push(...(await listRecentMeetings(sinceMs)));
    } catch (e) {
      sourceErrors.push('Read.ai: ' + String(e));
      await logAutomationFailure(supabaseAdmin, 'pull-meeting-summaries', 'Read.ai listRecentMeetings failed: ' + String(e));
    }

    let processed = 0;
    const skipped: string[] = [];

    for (const meeting of meetings) {
      if (meeting?.end_time_ms == null) continue; // still active, not ended yet — nothing to summarize

      const lead = await findLeadForMeeting(supabaseAdmin, meeting);
      if (!lead) {
        skipped.push(meeting.id);
        await logAutomationFailure(
          supabaseAdmin,
          'pull-meeting-summaries',
          `No lead found matching any participant/owner email for meeting ${meeting.id} — summary was not saved anywhere. Checked: ${collectCandidateEmails(meeting).join(', ') || '(no emails on the meeting)'}.`
        );
        continue;
      }

      const subjectKey = `readai-summary:${meeting.id}`;
      const { data: existingComm } = await supabaseAdmin
        .from('comm_log')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('type', 'meeting_summary')
        .eq('subject', subjectKey)
        .maybeSingle();
      if (existingComm) continue; // already saved, don't duplicate

      let meetingData: any;
      try {
        meetingData = await getMeetingSummary(meeting.id);
      } catch (e) {
        skipped.push(meeting.id);
        await logAutomationFailure(
          supabaseAdmin,
          'pull-meeting-summaries',
          `Lead matched (${lead.business_name}), but fetching the meeting summary from Read.ai failed: ${String(e)}`,
          lead.id
        );
        continue;
      }

      await supabaseAdmin.from('comm_log').insert([{
        lead_id: lead.id,
        type: 'meeting_summary',
        subject: subjectKey,
        content: formatSummaryContent(meetingData, meeting),
        sent_at: new Date(meeting.end_time_ms).toISOString(),
      }]);
      processed++;
    }

    return new Response(JSON.stringify({ ok: true, processed, skipped, sourceErrors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    try { await logAutomationFailure(getSupabaseAdmin(), 'pull-meeting-summaries', `Run failed entirely: ${String(e)}`); } catch { /* logging itself failed, nothing more to do */ }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
