// Scheduled via pg_cron. For every lead we've proposed a meeting time to
// but haven't locked one in yet, checks Gmail for a reply. A plain
// confirmation auto-locks the proposed time in; anything proposing a
// different time gets written to reschedule_flags instead of being
// auto-rescheduled — a human locks that in from the Inbox Manager.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { listGmailReplies } from '../_shared/gmail.ts';
import { callClaude, stripJsonFence } from '../_shared/claude.ts';
import { requireCredential } from '../_shared/credentials.ts';
import { corsHeaders } from '../_shared/cors.ts';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const anthropicCred = await requireCredential(supabaseAdmin, 'anthropic', 'Claude (Anthropic)');
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

      const result = await callClaude(
        anthropicCred.value,
        'You are classifying an email reply about a proposed meeting time. Return ONLY valid JSON, no markdown fences, with keys: type ("confirms_time" | "requests_different_time" | "unrelated"), summary (one sentence describing what they said).',
        `Email reply:\n${bodyText}`
      );
      let parsed: any;
      try {
        parsed = JSON.parse(stripJsonFence(result));
      } catch {
        continue;
      }

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
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
