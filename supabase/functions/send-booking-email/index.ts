// Invoked directly from the app when Mary clicks "Confirm & Send" in the
// Book Meeting modal — the one manual step in the whole funnel. Everything
// downstream of the click (sending the proposed-time email) is automatic.
// The email body itself is a static template, and the meeting-prep brief
// generated right after is a templated document built from data already in
// the system — no LLM call anywhere in this function.
//
// AUTO-SEND KILL SWITCH: checked first — if off, nothing in this function
// runs (no email, no stage change, no meeting-prep brief), since none of
// that should happen if the email supposedly confirming it never went out.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { sendGmail, textToHtmlBody } from '../_shared/gmail.ts';
import { requireCredential } from '../_shared/credentials.ts';
import { generateMeetingPrepBrief } from '../_shared/meetingPrep.ts';
import { isAutoSendEnabled } from '../_shared/autoSend.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { leadId, proposedDateTime } = await req.json();
    if (!leadId || !proposedDateTime) throw new Error('leadId and proposedDateTime are required');

    const supabaseAdmin = getSupabaseAdmin();

    if (!(await isAutoSendEnabled(supabaseAdmin))) {
      await logAutomationFailure(supabaseAdmin, 'send-booking-email', 'Auto-send is disabled in Settings — booking confirmation email was not sent.', leadId);
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'auto-send disabled' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const gmailCred = await requireCredential(supabaseAdmin, 'gmail', 'Gmail');
    if (!gmailCred.meta?.email) throw new Error('Gmail is connected but has no account email on file — reconnect in Settings.');

    const { data: lead } = await supabaseAdmin.from('leads').select('*').eq('id', leadId).maybeSingle();
    if (!lead) throw new Error('Lead not found');
    if (!lead.email) throw new Error('Lead has no email on file');

    const subject = "Let's find time to talk";
    const body = `Hi ${lead.contact_name || 'there'},

Thanks for your interest! I'd like to propose ${proposedDateTime} for our call.

If that works for you, just reply to confirm. If not, let me know a time that works better and we'll get it locked in.

Talk soon,
Social Practice`;

    await sendGmail(gmailCred.value, gmailCred.meta.email, lead.email, subject, textToHtmlBody(body));

    await supabaseAdmin
      .from('leads')
      .update({
        meeting_proposed_at: new Date().toISOString(),
        stage: 'Discovery Booked',
        next_followup: String(proposedDateTime).slice(0, 10),
      })
      .eq('id', leadId);

    // Meeting-prep brief: best-effort, doesn't block the booking email itself if it fails.
    let brief: string | null = null;
    try {
      brief = await generateMeetingPrepBrief(supabaseAdmin, leadId);
    } catch (e) {
      console.warn('Meeting-prep brief generation failed:', String(e));
    }

    return new Response(JSON.stringify({ ok: true, subject, body, brief }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
