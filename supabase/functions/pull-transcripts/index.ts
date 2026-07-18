// Scheduled via pg_cron. Polls Read.ai AND Fathom for completed call
// transcripts, matches each to a lead by attendee email, and appends it
// to that lead's comm_log automatically — no manual copy-paste.
//
// Read.ai and Fathom are independent, parallel, both-optional credentials.
// Fathom is being introduced alongside Read.ai, not replacing it — this
// function pulls from whichever one(s) are connected; neither is required
// on its own, only "at least one."
//
// NOTETAKER -> HUBSPOT (Mary's stated #1 priority): after a transcript is
// appended to comm_log, if HubSpot + Anthropic are both connected and the
// lead has a hubspot_contact_id on file, Claude extracts structured call
// info (summary, key details, next steps, budget/timeline signals) and
// pushes it to HubSpot as a note on the contact — not just kept in our own
// history log. This builds on the comm_log append above rather than
// duplicating the transcript pull; it's a best-effort extra step per
// session and never blocks the underlying transcript append if it fails
// (missing credentials, no hubspot_contact_id, or a HubSpot API error).
//
// NOTE: Neither Read.ai's nor Fathom's exact endpoint path/response shape
// is verified against official documentation — both are best-effort
// guesses at a reasonable REST contract. Adjust the fetch URLs and field
// names in fetchReadaiSessions/fetchFathomCalls once you have real API
// access and can confirm the actual shape for each.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { getCredential } from '../_shared/credentials.ts';
import { callClaude, stripJsonFence } from '../_shared/claude.ts';
import { createHubspotNote } from '../_shared/hubspot.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

interface NormalizedSession {
  source: 'readai' | 'fathom';
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

async function fetchFathomCalls(key: string): Promise<NormalizedSession[]> {
  const res = await fetch('https://api.fathom.video/v1/calls?limit=25', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error('Fathom returned ' + res.status);
  const data = await res.json();
  const calls = data.calls || data.results || data.items || [];
  return calls.map((call: any): NormalizedSession => ({
    source: 'fathom',
    id: call.id || call.call_id || '',
    attendeeEmail: (call.invitees?.[0]?.email || call.attendees?.[0]?.email || '').toLowerCase(),
    transcript: call.transcript || call.transcript_text || JSON.stringify(call).slice(0, 8000),
    endedAt: call.ended_at || call.recording_end_time || new Date().toISOString(),
  }));
}

async function pushNoteToHubspot(
  hubspotKey: string,
  anthropicKey: string,
  lead: { hubspot_contact_id: string | null; hubspot_deal_id: string | null; business_name: string; contact_name: string },
  transcript: string
): Promise<void> {
  if (!lead.hubspot_contact_id) throw new Error('lead has no hubspot_contact_id on file');

  const extraction = await callClaude(
    anthropicKey,
    'You are extracting structured notes from a sales call transcript for a medical aesthetics marketing agency, to log in HubSpot. Use ONLY what is actually in the transcript — never invent details.',
    `Call transcript for ${lead.contact_name} at ${lead.business_name}:\n\n${transcript}\n\nReturn ONLY valid JSON (no markdown fences) with these keys: call_summary (2-3 sentences), key_details (array of short strings — specific things discussed), next_steps (array of short strings), budget_signal (one sentence, or "Not discussed" if unclear), timeline_signal (one sentence, or "Not discussed" if unclear).`,
    900
  );

  let parsed: any;
  try { parsed = JSON.parse(stripJsonFence(extraction)); }
  catch { parsed = { call_summary: extraction.slice(0, 1000), key_details: [], next_steps: [], budget_signal: 'Not discussed', timeline_signal: 'Not discussed' }; }

  const noteBody = [
    `Call Summary: ${parsed.call_summary || 'n/a'}`,
    '',
    'Key Details:',
    ...(parsed.key_details || []).map((d: string) => `- ${d}`),
    '',
    'Next Steps:',
    ...(parsed.next_steps || []).map((s: string) => `- ${s}`),
    '',
    `Budget Signal: ${parsed.budget_signal || 'Not discussed'}`,
    `Timeline Signal: ${parsed.timeline_signal || 'Not discussed'}`,
    '',
    '(Auto-extracted from call transcript by the Social Practice Sales Engine)',
  ].join('\n');

  await createHubspotNote(hubspotKey, lead.hubspot_contact_id, lead.hubspot_deal_id, noteBody);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const readaiCred = await getCredential(supabaseAdmin, 'readai');
    const fathomCred = await getCredential(supabaseAdmin, 'fathom');
    const hubspotCred = await getCredential(supabaseAdmin, 'hubspot');
    const anthropicCred = await getCredential(supabaseAdmin, 'anthropic');

    if (!readaiCred && !fathomCred) {
      throw new Error('Neither Read.ai nor Fathom is connected — add at least one in Settings.');
    }

    const sessions: NormalizedSession[] = [];
    const sourceErrors: string[] = [];

    if (readaiCred) {
      try { sessions.push(...(await fetchReadaiSessions(readaiCred.value))); }
      catch (e) {
        sourceErrors.push('Read.ai: ' + String(e));
        await logAutomationFailure(supabaseAdmin, 'pull-transcripts', 'Read.ai fetch failed: ' + String(e));
      }
    }
    if (fathomCred) {
      try { sessions.push(...(await fetchFathomCalls(fathomCred.value))); }
      catch (e) {
        sourceErrors.push('Fathom: ' + String(e));
        await logAutomationFailure(supabaseAdmin, 'pull-transcripts', 'Fathom fetch failed: ' + String(e));
      }
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
      if (hubspotCred && anthropicCred && lead.hubspot_contact_id) {
        try {
          await pushNoteToHubspot(hubspotCred.value, anthropicCred.value, lead, session.transcript);
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
