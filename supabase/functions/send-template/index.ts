// The "outreach layer" send path — invoked only when a human clicks Send
// after previewing a template (see index.html's Templates picker). Input:
// { lead_id, template_id }. Fills merge fields, resolves any stored-link
// spans the Templates editor inserted (Settings > Forms & Links, via
// bodyWithLinks — see _shared/gmail.ts), sends via Mary's Gmail, logs to
// comm_log, and pushes a note to the contact's HubSpot timeline.
//
// NOT gated by the auto-send kill switch (_shared/autoSend.ts) — that
// switch exists to hold back functions that could otherwise send
// unattended (cron/webhook-triggered). This function has no automatic
// trigger at all yet (explicitly out of scope for this pass — "do not
// build the auto-trigger logic itself yet") and only ever runs because a
// human clicked Send after a preview, so gating it behind a switch whose
// entire purpose is stopping *unattended* sends would just block Mary's
// own manual sends today. When a future phase adds automatic dispatch
// calling into this same function, that dispatch path should check
// isAutoSendEnabled itself before calling send-template — not this file.
//
// HARD DEPENDENCY: Mary's Gmail must be connected under her own account
// (mary@social-practicetx.com), not Zane's personal Gmail. This is
// enforced at runtime below by checking the connected account's email —
// if Gmail isn't connected, or is connected as a different account, this
// function refuses to send and logs a clear reason. That check IS the
// "stub behind a TODO" the spec asked for if the reconnection isn't done
// yet: it's a real runtime guard rather than commented-out code, so it
// self-resolves the moment the real account is reconnected, with no
// further code change needed.
//
// HUBSPOT WRITE-BACK: pushed as a note on the contact's timeline
// (createHubspotNote), not a structured property update. Two reasons:
// (1) I cannot confirm from this codebase whether Mary's Gmail account
// has HubSpot's native Gmail/Sales-extension sync active — that's a
// Google Workspace / HubSpot Sales Hub setting, not data stored anywhere
// in Sales-AI, so I'm not relying on it silently catching this email.
// (2) a note is one of the three write-back targets the spec itself
// offered ("lifecycle stage / timeline / relevant property") and is the
// one that can't accidentally trip a property-driven HubSpot Workflow —
// the spec explicitly warns not to disturb existing Workflows. If you'd
// rather this write a specific structured property instead, tell me
// which one and I'll add it.
//
// No LLM calls anywhere in this file.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { requireCredential, getCredential } from '../_shared/credentials.ts';
import { sendGmail, bodyWithLinks } from '../_shared/gmail.ts';
import { createHubspotNote } from '../_shared/hubspot.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

// Mary's own account — the one this function is allowed to send from.
// Not Zane's personal Gmail, per the spec's explicit instruction.
const MARY_GMAIL_ADDRESS = 'mary@social-practicetx.com';

// Same merge-field set the frontend preview (index.html) fills in before
// showing Mary the preview — kept in sync manually since there's no
// shared JS module between the browser and this Deno function in this
// codebase's architecture. If you add a merge field here, add it there
// too (and vice versa).
function fillMergeFields(template: string, lead: any): string {
  const contactName = (lead.contact_name || '').trim();
  const nameParts = contactName.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ');

  const values: Record<string, string> = {
    first_name: firstName,
    last_name: lastName,
    contact_name: contactName,
    practice_name: lead.business_name || '',
    business_name: lead.business_name || '',
    email: lead.email || '',
  };

  // Unresolved merge fields are left as-is (e.g. "{{unknown_field}}")
  // rather than blanked out — a visibly unfilled field in the preview is
  // something Mary would notice and catch; a silently blanked one isn't.
  return template.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (match, key) => (key in values ? values[key] : match));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();
    // subject_override / body_override are optional — the frontend's
    // preview modal lets Mary edit the filled-in text before sending, and
    // passes the edited text through here so it's what actually goes out
    // rather than being silently discarded in favor of a fresh server-side
    // fill. A future automatic-dispatch path (out of scope for this pass)
    // would call this with just lead_id + template_id, exactly per the
    // spec's stated input contract, and get the template's own merge-filled
    // text with no editing step.
    const { lead_id, template_id, subject_override, body_override } = await req.json();
    if (!lead_id || !template_id) throw new Error('lead_id and template_id are required');

    const { data: lead } = await supabaseAdmin.from('leads').select('*').eq('id', lead_id).maybeSingle();
    if (!lead) throw new Error('Lead not found');
    if (!lead.email) throw new Error('Lead has no email on file');

    const { data: template } = await supabaseAdmin.from('templates').select('*').eq('id', template_id).maybeSingle();
    if (!template) throw new Error('Template not found');

    const gmailCred = await requireCredential(supabaseAdmin, 'gmail', 'Gmail');
    const connectedEmail = gmailCred.meta?.email;
    if (connectedEmail !== MARY_GMAIL_ADDRESS) {
      const detail = connectedEmail
        ? `Gmail is connected as ${connectedEmail}, not ${MARY_GMAIL_ADDRESS} — refusing to send. Reconnect Gmail under Mary's own account in Settings before using Templates.`
        : `Gmail is connected but has no account email on file — reconnect in Settings before using Templates.`;
      await logAutomationFailure(supabaseAdmin, 'send-template', detail, lead_id);
      return new Response(JSON.stringify({ ok: false, error: detail }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const subject = typeof subject_override === 'string' && subject_override.trim() ? subject_override : fillMergeFields(template.subject, lead);
    const body = typeof body_override === 'string' && body_override.trim() ? body_override : fillMergeFields(template.body, lead);

    // Templates can reference stored links (Settings > Forms & Links) as
    // `[label](key)` spans anywhere in the body — resolved to real <a>
    // tags here, at send time, against whatever's actually saved right
    // now. A key with no saved URL yet degrades to plain text rather
    // than blocking the send (see bodyWithLinks).
    const { data: appLinks } = await supabaseAdmin.from('app_links').select('key, value');
    const linkMap: Record<string, string | null> = {};
    for (const row of appLinks || []) linkMap[row.key] = row.value;

    await sendGmail(gmailCred.value, connectedEmail, lead.email, subject, bodyWithLinks(body, linkMap));

    await supabaseAdmin.from('comm_log').insert([{
      lead_id,
      type: 'template_send',
      subject: `${template.name}: ${subject}`,
      content: body,
      sent_at: new Date().toISOString(),
    }]);

    if (lead.hubspot_contact_id) {
      const hubspotCred = await getCredential(supabaseAdmin, 'hubspot');
      if (hubspotCred) {
        try {
          await createHubspotNote(
            hubspotCred.value,
            lead.hubspot_contact_id,
            lead.hubspot_deal_id || null,
            `Sent template "${template.name}" via Sales-AI.\n\nSubject: ${subject}\n\n${body}`
          );
        } catch (e) {
          // Best-effort — the email itself already sent and comm_log
          // already has it, which is what matters most.
          await logAutomationFailure(
            supabaseAdmin,
            'send-template',
            `Email sent and logged, but pushing the HubSpot timeline note failed: ${String(e)}`,
            lead_id
          );
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, subject, body }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    try { await logAutomationFailure(getSupabaseAdmin(), 'send-template', `Run failed entirely: ${String(e)}`); } catch { /* logging itself failed, nothing more to do */ }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
