// Scheduled via pg_cron. Polls Read.ai for completed call transcripts,
// matches each to a lead by attendee email, and appends it to that lead's
// comm_log automatically — no manual copy-paste. Read.ai is the sole
// transcript source (Fathom support was removed entirely — no backend
// code path, no credential lookup, no fetch).
//
// NOTETAKER -> HUBSPOT (Mary's stated #1 priority): after a transcript is
// appended to comm_log, if HubSpot is connected and the lead has a
// hubspot_contact_id on file, the raw transcript text is pushed to HubSpot
// as a note on the contact — not just kept in our own history log. This
// builds on the comm_log append above rather than duplicating the transcript
// pull; it's a best-effort extra step per session and never blocks the
// underlying transcript append if it fails (missing credentials, no
// hubspot_contact_id, or a HubSpot API error). No LLM summarization — the
// note is the transcript text itself, truncated to a safe length.
//
// NOTE: Read.ai's exact endpoint path/response shape is not verified
// against official documentation — it's a best-effort guess at a
// reasonable REST contract. Adjust the fetch URL and field names in
// fetchReadaiSessions once you have real API access and can confirm the
// actual shape.
//
// AUTO-SEND KILL SWITCH: gates only the HubSpot note push below (a write to
// an external system that could itself trigger a HubSpot workflow) — the
// comm_log transcript append is our own internal history, not a "send", so
// it always runs regardless of this setting.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { getCredential } from '../_shared/credentials.ts';
import { createHubspotNote } from '../_shared/hubspot.ts';
import { isAutoSendEnabled } from '../_shared/autoSend.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

interface NormalizedSession {
  source: 'readai';
  id: string;
  attendeeEmail: string;
  transcript: string;
  endedAt: string;
}

async function fetchReadaiSessions(key: string): Promise<NormalizedSession[]> {
  const res = await fetch('https://api.read.ai/v1/sessions?limit=25', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error('Read.ai returned ' + res.status);
  const data = await res.json();
  const sessions = data.sessions || data.results || data.items || [];
  return sessions.map((session: any): NormalizedSession => ({
    source: 'readai',
    id: session.id || session.session_id || '',
    attendeeEmail: (session.attendees?.[0]?.email || session.participant_email || '').toLowerCase(),
    transcript: session.transcript || session.transcript_text || JSON.stringify(session).slice(0, 8000),
    endedAt: session.ended_at || session.created_at || new Date().toISOString(),
  }));
}

async function pushNoteToHubspot(
  hubspotKey: string,
  lead: { hubspot_contact_id: string | null; hubspot_deal_id: string | null; business_name: string; contact_name: string },
  transcript: string,
  source: string
): Promise<void> {
  if (!lead.hubspot_contact_id) throw new Error('lead has no hubspot_contact_id on file');

  const truncated = transcript.length > 4000;
  const noteBody = [
    `Call transcript (${source}) — ${lead.contact_name} at ${lead.business_name}:`,
    '',
    transcript.slice(0, 4000),
    truncated ? `\n(transcript truncated — see full recording in ${source})` : '',
    '',
    '(Auto-logged from call transcript by the Social Practice Sales Engine)',
  ].filter(Boolean).join('\n');

  await createHubspotNote(hubspotKey, lead.hubspot_contact_id, lead.hubspot_deal_id, noteBody);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const readaiCred = await getCredential(supabaseAdmin, 'readai');
    const hubspotCred = await getCredential(supabaseAdmin, 'hubspot');
    const autoSend = await isAutoSendEnabled(supabaseAdmin);

    if (!readaiCred) {
      throw new Error('Read.ai is not connected — add it in Settings.');
    }

    const sessions: NormalizedSession[] = [];
    const sourceErrors: string[] = [];

    try {
      sessions.push(...(await fetchReadaiSessions(readaiCred.value)));
    } catch (e) {
      sourceErrors.push('Read.ai: ' + String(e));
      await logAutomationFailure(supabaseAdmin, 'pull-transcripts', 'Read.ai fetch failed: ' + String(e));
    }

    let appended = 0;
    let hubspotNotesPushed = 0;
    const skipped: string[] = [];
    const hubspotErrors: string[] = [];

    for (const session of sessions) {
      if (!session.attendeeEmail) continue;

      const { data: lead } = await supabaseAdmin
        .from('leads')
        .select('id, business_name, contact_name, hubspot_contact_id, hubspot_deal_id')
        .ilike('email', session.attendeeEmail)
        .maybeSingle();
      if (!lead) {
        skipped.push(session.attendeeEmail);
        await logAutomationFailure(
          supabaseAdmin,
          'pull-transcripts',
          `No lead found matching attendee email "${session.attendeeEmail}" (${session.source} session ${session.id}) — transcript was not saved anywhere. Check the lead's email on file, or whether the attendee list put someone other than the prospect first.`
        );
        continue;
      }

      const subjectKey = `${session.source}:${session.id}`;
      const { data: existingComm } = await supabaseAdmin
        .from('comm_log')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('type', 'meeting_transcript')
        .eq('subject', subjectKey)
        .maybeSingle();
      if (existingComm) continue; // already appended, don't duplicate

      await supabaseAdmin.from('comm_log').insert([{
        lead_id: lead.id,
        type: 'meeting_transcript',
        subject: subjectKey,
        content: session.transcript,
        sent_at: session.endedAt,
      }]);
      appended++;

      // Notetaker -> HubSpot: best-effort, never blocks the transcript append above.
      if (!autoSend) {
        if (hubspotCred && lead.hubspot_contact_id) {
          await logAutomationFailure(
            supabaseAdmin,
            'pull-transcripts',
            'Auto-send is disabled in Settings — transcript was saved, but the HubSpot note was not pushed.',
            lead.id
          );
        }
      } else if (hubspotCred && lead.hubspot_contact_id) {
        try {
          await pushNoteToHubspot(hubspotCred.value, lead, session.transcript, session.source);
          hubspotNotesPushed++;
        } catch (e) {
          hubspotErrors.push(`${lead.business_name}: ${String(e)}`);
          await logAutomationFailure(
            supabaseAdmin,
            'pull-transcripts',
            `Call transcript was saved, but pushing the note to HubSpot failed: ${String(e)}`,
            lead.id
          );
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, appended, hubspotNotesPushed, skipped, sourceErrors, hubspotErrors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    try { await logAutomationFailure(getSupabaseAdmin(), 'pull-transcripts', `Run failed entirely: ${String(e)}`); } catch { /* logging itself failed, nothing more to do */ }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
