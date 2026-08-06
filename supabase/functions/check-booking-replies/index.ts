// Scheduled via pg_cron. For every lead we've proposed a meeting time to
// but haven't locked one in yet, checks Gmail for a reply. A plain
// confirmation auto-locks the proposed time in; anything proposing a
// different time gets written to reschedule_flags instead of being
// auto-rescheduled — a human locks that in from the Inbox Manager.
//
// Classification is deterministic keyword matching (no LLM call) — reschedule
// keywords are checked first since misclassifying a reschedule request as a
// confirmation is worse than the reverse. This is less nuanced than an LLM
// read of the email and may need its keyword lists tuned against real replies.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { listGmailReplies } from '../_shared/gmail.ts';
import { requireCredential } from '../_shared/credentials.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

function decodeBody(payload: any): string {
  const part = payload?.parts?.find((p: any) => p.mimeType === 'text/plain') || payload;
  const data = part?.body?.data;
  if (!data) return payload?.snippet || '';
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return atob(normalized);
  } catch {
    return payload?.snippet || '';
  }
}

const RESCHEDULE_KEYWORDS = [
  'reschedule', 'different time', 'another time', 'other time', "can't make",
  'cannot make', "doesn't work", 'does not work', 'conflict', 'push it back',
  'move it', 'different day', 'another day', 'change the time', 'push back',
];
const CONFIRM_KEYWORDS = [
  'confirm', 'confirmed', 'sounds good', 'works for me', 'that works',
  'see you then', 'perfect', "i'll be there", 'looking forward', 'works great',
];

function classifyReply(bodyText: string): { type: 'confirms_time' | 'requests_different_time' | 'unrelated'; summary: string } {
  const text = bodyText.toLowerCase();
  if (RESCHEDULE_KEYWORDS.some((k) => text.includes(k))) {
    return { type: 'requests_different_time', summary: 'Reply contains reschedule-related keywords.' };
  }
  if (CONFIRM_KEYWORDS.some((k) => text.includes(k))) {
    return { type: 'confirms_time', summary: 'Reply contains confirmation keywords.' };
  }
  return { type: 'unrelated', summary: 'No confirmation or reschedule keywords detected.' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const gmailCred = await requireCredential(supabaseAdmin, 'gmail', 'Gmail');

    const { data: leads } = await supabaseAdmin
      .from('leads')
      .select('*')
      .not('meeting_proposed_at', 'is', null)
      .is('meeting_scheduled_at', null);

    let flagged = 0;
    let confirmed = 0;

    for (const lead of leads || []) {
      if (!lead.email) continue;

      const messages = await listGmailReplies(gmailCred.value, `from:${lead.email} newer_than:7d`);
      if (!messages.length) continue;

      const latest = messages[0];
      const bodyText = decodeBody(latest.payload);
      if (!bodyText) continue;

      const parsed = classifyReply(bodyText);

      if (parsed.type === 'confirms_time') {
        await supabaseAdmin
          .from('leads')
          .update({
            meeting_scheduled_at: lead.next_followup ? `${lead.next_followup}T00:00:00Z` : new Date().toISOString(),
          })
          .eq('id', lead.id);
        confirmed++;
      } else if (parsed.type === 'requests_different_time') {
        await supabaseAdmin.from('reschedule_flags').insert([{
          lead_id: lead.id,
          detected_message: parsed.summary,
          raw_email_snippet: bodyText.slice(0, 500),
        }]);
        flagged++;
      }
    }

    return new Response(JSON.stringify({ ok: true, flagged, confirmed }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    try { await logAutomationFailure(getSupabaseAdmin(), 'check-booking-replies', `Run failed entirely: ${String(e)}`); } catch { /* logging itself failed, nothing more to do */ }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
