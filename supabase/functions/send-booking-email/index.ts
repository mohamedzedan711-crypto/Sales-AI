// Invoked directly from the app when Mary clicks "Confirm & Send" in the
// Book Meeting modal — the one manual step in the whole funnel. Everything
// downstream of the click (drafting + sending the proposed-time email) is
// automatic.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { callClaude } from '../_shared/claude.ts';
import { getVoiceProfileBlock, buildSystemPrompt } from '../_shared/voice.ts';
import { sendGmail } from '../_shared/gmail.ts';
import { requireCredential } from '../_shared/credentials.ts';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { leadId, proposedDateTime } = await req.json();
    if (!leadId || !proposedDateTime) throw new Error('leadId and proposedDateTime are required');

    const supabaseAdmin = getSupabaseAdmin();
    const anthropicCred = await requireCredential(supabaseAdmin, 'anthropic', 'Claude (Anthropic)');
    const gmailCred = await requireCredential(supabaseAdmin, 'gmail', 'Gmail');
    if (!gmailCred.meta?.email) throw new Error('Gmail is connected but has no account email on file — reconnect in Settings.');

    const { data: lead } = await supabaseAdmin.from('leads').select('*').eq('id', leadId).maybeSingle();
    if (!lead) throw new Error('Lead not found');
    if (!lead.email) throw new Error('Lead has no email on file');

    const voiceBlock = await getVoiceProfileBlock(supabaseAdmin);
    const draft = await callClaude(
      anthropicCred.value,
      buildSystemPrompt(
        `Task: Propose a meeting time to a qualified lead who is ready for their strategy call. Proposed time: ${proposedDateTime}. Ask them to confirm this time or reply with a preferred alternative if it doesn't work. Write ONLY the email — first line "Subject: ..." then the body.`,
        voiceBlock
      ),
      `Lead: ${lead.contact_name} from ${lead.business_name}. Qualification reason on file: ${lead.qualification_reason || 'n/a'}.`
    );

    const subjectMatch = draft.match(/^Subject:\s*(.+)$/mi);
    const subject = subjectMatch ? subjectMatch[1].trim() : "Let's find time to talk";
    const body = draft.replace(/^Subject:.*$/mi, '').trim();

    await sendGmail(gmailCred.value, gmailCred.meta.email, lead.email, subject, body);

    await supabaseAdmin
      .from('leads')
      .update({
        meeting_proposed_at: new Date().toISOString(),
        stage: 'Discovery Booked',
        next_followup: String(proposedDateTime).slice(0, 10),
      })
      .eq('id', leadId);

    return new Response(JSON.stringify({ ok: true, subject, body }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
