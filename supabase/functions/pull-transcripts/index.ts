// Scheduled via pg_cron. Polls Read.ai for completed call transcripts,
// matches each to a lead by attendee email, and appends it to that lead's
// comm_log automatically — no manual copy-paste.
//
// NOTE: Read.ai's exact endpoint path and response shape are not verified
// against official documentation. Adjust the fetch URL and the field names
// below (session.attendees, session.transcript, etc.) once you have real
// Read.ai API access and can confirm the actual contract.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { requireCredential } from '../_shared/credentials.ts';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const readaiCred = await requireCredential(supabaseAdmin, 'readai', 'Read.ai');

    const res = await fetch('https://api.read.ai/v1/sessions?limit=25', {
      headers: { Authorization: `Bearer ${readaiCred.value}` },
    });
    if (!res.ok) throw new Error('Read.ai returned ' + res.status);
    const data = await res.json();
    const sessions = data.sessions || data.results || data.items || [];

    let appended = 0;
    const skipped: string[] = [];

    for (const session of sessions) {
      const attendeeEmail = (session.attendees?.[0]?.email || session.participant_email || '').toLowerCase();
      if (!attendeeEmail) continue;

      const { data: lead } = await supabaseAdmin
        .from('leads')
        .select('id')
        .ilike('email', attendeeEmail)
        .maybeSingle();
      if (!lead) {
        skipped.push(attendeeEmail);
        continue;
      }

      const sessionId = session.id || session.session_id || '';
      const { data: existingComm } = await supabaseAdmin
        .from('comm_log')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('type', 'meeting_transcript')
        .eq('subject', sessionId)
        .maybeSingle();
      if (existingComm) continue; // already appended, don't duplicate

      const transcript = session.transcript || session.transcript_text || JSON.stringify(session).slice(0, 8000);

      await supabaseAdmin.from('comm_log').insert([{
        lead_id: lead.id,
        type: 'meeting_transcript',
        subject: sessionId || 'Read.ai session',
        content: transcript,
        sent_at: session.ended_at || session.created_at || new Date().toISOString(),
      }]);
      appended++;
    }

    return new Response(JSON.stringify({ ok: true, appended, skipped }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
