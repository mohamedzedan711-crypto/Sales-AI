// Invoked directly from the app (anon key) when the user clicks "Send" on
// the Nurture/Recap/Follow-Up/Reactivate/Book-Call draft modal. Doesn't draft
// anything itself — the message is written manually in the textarea (no AI
// drafting anywhere in this app anymore) before Send is clicked; this
// function just sends whatever subject/body it's given.
//
// AUTO-SEND KILL SWITCH: checked first — if off, nothing is sent and
// last_contact is not touched.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { sendGmail, textToHtmlBody } from '../_shared/gmail.ts';
import { requireCredential } from '../_shared/credentials.ts';
import { isAutoSendEnabled } from '../_shared/autoSend.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { leadId, subject, body } = await req.json();
    if (!leadId || !subject || !body) throw new Error('leadId, subject, and body are required');

    const supabaseAdmin = getSupabaseAdmin();

    if (!(await isAutoSendEnabled(supabaseAdmin))) {
      await logAutomationFailure(supabaseAdmin, 'send-lead-email', 'Auto-send is disabled in Settings — this email was not sent.', leadId);
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'auto-send disabled' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: lead } = await supabaseAdmin.from('leads').select('*').eq('id', leadId).maybeSingle();
    if (!lead) throw new Error('Lead not found');
    if (!lead.email) throw new Error('Lead has no email on file');

    const gmailCred = await requireCredential(supabaseAdmin, 'gmail', 'Gmail');
    if (!gmailCred.meta?.email) throw new Error('Gmail is connected but has no account email on file — reconnect in Settings.');

    await sendGmail(gmailCred.value, gmailCred.meta.email, lead.email, subject, textToHtmlBody(body));

    await supabaseAdmin
      .from('leads')
      .update({ last_contact: new Date().toISOString().slice(0, 10) })
      .eq('id', leadId);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
