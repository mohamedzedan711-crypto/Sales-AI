// Invoked directly from the app (anon key) when the user clicks "Send" on
// an AI draft modal — Nurture, Recap, Follow-Up, Reactivate, or the
// Follow-Up Tracker's own draft flow. Unlike send-booking-email, this
// doesn't draft anything with Claude — it just sends whatever subject/body
// it's given, since the drafting (and any user edits) already happened in
// the textarea before Send was clicked.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { sendGmail, textToHtmlBody } from '../_shared/gmail.ts';
import { requireCredential } from '../_shared/credentials.ts';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { leadId, subject, body } = await req.json();
    if (!leadId || !subject || !body) throw new Error('leadId, subject, and body are required');

    const supabaseAdmin = getSupabaseAdmin();

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
