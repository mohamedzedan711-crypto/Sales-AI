// Triggered by a Supabase Database Webhook on INSERT to `leads` (see
// DEPLOYMENT.md for the exact webhook setup). Automatically emails a new
// lead a link to questionnaire.html — no manual button, fires the moment a
// lead row is created, whatever its source.
//
// sync-hubspot-leads already sets questionnaire_token/questionnaire_sent_at
// at insert time and sends its own questionnaire email inline for every
// HubSpot-synced lead — so if this function generated a second token for
// those rows, it would double-email the lead AND silently invalidate the
// link already sent (the token in that first email would no longer match
// what's on the row). Since sync-hubspot-leads isn't being touched, this
// function instead skips any row that already arrived with
// questionnaire_sent_at set, leaving that case entirely to sync-hubspot-leads.
// This makes it the sole sender for every other lead-creation path (chiefly
// manual "+ Add Lead" in the Sales Pipeline tab, which never sets those
// fields client-side).
//
// IDEMPOTENCY: confirmed in production that the webhook trigger's HTTP call
// was timing out (5s timeout, function regularly took longer — Gmail token
// refresh + drafting the email body + Gmail send + DB write), and each timeout caused
// Supabase to redeliver the SAME original INSERT event, sometimes several
// at once. The old guard checked `payload.record.questionnaire_sent_at` —
// but that's a snapshot frozen at the moment of the original INSERT, so
// every redelivery carries the same stale `null` and sails right past a
// payload-only check. Fixed by claiming the row with an atomic conditional
// UPDATE (`questionnaire_sent_at IS NULL`) as the very first DB operation,
// before any of the slow work — if a concurrent/retried invocation already
// claimed it, this affects zero rows and we bail immediately. A plain
// re-SELECT-then-check-then-later-write has a race window a same-instant
// retry can slip through; the conditional UPDATE doesn't.
//
// The email body is a static template (no LLM call) as of the deterministic-
// automation redesign — see sync-hubspot-leads for the identical template
// used on the HubSpot-sync path.
//
// AUTO-SEND KILL SWITCH: checked first, before the atomic claim below — if
// auto-send is off, this function returns without claiming the row, so the
// lead stays eligible to be emailed once auto-send is turned back on (there
// is no automatic retry; a human can resend manually via send-lead-email,
// or the row just waits).

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { sendGmail, bodyWithLink, LINK_MARKER } from '../_shared/gmail.ts';
import { requireCredential } from '../_shared/credentials.ts';
import { isAutoSendEnabled } from '../_shared/autoSend.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const payload = await req.json();
    const leadFromPayload = payload.record;
    if (!leadFromPayload) throw new Error('No record in webhook payload');

    const supabaseAdmin = getSupabaseAdmin();

    if (!(await isAutoSendEnabled(supabaseAdmin))) {
      await logAutomationFailure(
        supabaseAdmin,
        'send-questionnaire-email',
        'Auto-send is disabled in Settings — questionnaire email was not sent.',
        leadFromPayload.id
      );
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'auto-send disabled' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Atomic claim: only succeeds (returns a row) if questionnaire_sent_at
    // is still null right now, in the live table — not in the payload
    // snapshot, which is stale on any retry/redelivery. This is the actual
    // idempotency guard; everything below only runs if we won the claim.
    const { data: lead, error: claimError } = await supabaseAdmin
      .from('leads')
      .update({ questionnaire_sent_at: new Date().toISOString() })
      .eq('id', leadFromPayload.id)
      .is('questionnaire_sent_at', null)
      .select()
      .maybeSingle();

    if (claimError) throw new Error(`Could not claim lead ${leadFromPayload.id}: ${claimError.message}`);

    if (!lead) {
      // Someone else (a retry of this same event, a concurrent invocation,
      // or sync-hubspot-leads at insert time) already claimed/sent this one.
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'questionnaire_sent_at already set — already claimed by another invocation' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!lead.email) throw new Error(`Lead ${lead.id} has no email on file — cannot send questionnaire (already marked as attempted; will need manual follow-up)`);

    const gmailCred = await requireCredential(supabaseAdmin, 'gmail', 'Gmail');
    if (!gmailCred.meta?.email) throw new Error('Gmail is connected but has no account email on file — reconnect in Settings (already marked as attempted; will need manual follow-up).');

    const token = crypto.randomUUID();
    const baseUrl = (Deno.env.get('QUESTIONNAIRE_BASE_URL') || '').replace(/\/$/, '');
    const link = `${baseUrl}/questionnaire.html?lead=${lead.id}&token=${token}`;

    const subject = 'A few quick questions before we chat';
    const body = `Hi ${lead.contact_name || 'there'},

Thanks for reaching out! Before our call, it'd help to know a bit more about your practice and what you're looking for.

Could you ${LINK_MARKER} answer a few quick questions? It only takes about 3 minutes.

Talk soon,
Social Practice`;

    await sendGmail(gmailCred.value, gmailCred.meta.email, lead.email, subject, bodyWithLink(body, link));

    // questionnaire_sent_at was already set by the claim above — this just
    // records which token the email that actually went out was built with.
    await supabaseAdmin
      .from('leads')
      .update({ questionnaire_token: token })
      .eq('id', lead.id);

    return new Response(JSON.stringify({ ok: true, subject, body, questionnaire_token: token }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    try { await logAutomationFailure(getSupabaseAdmin(), 'send-questionnaire-email', `Questionnaire email not sent: ${String(e)}`); } catch { /* logging itself failed, nothing more to do */ }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
