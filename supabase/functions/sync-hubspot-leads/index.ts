// Scheduled via pg_cron (see DEPLOYMENT.md). Pulls new HubSpot contacts,
// creates a lead + a unique questionnaire link for each, and emails it.
// The email body is a static template (no LLM call) as of the deterministic-
// automation redesign — see send-questionnaire-email for the identical
// template used on every other lead-creation path.
//
// AUTO-SEND KILL SWITCH: lead creation (the deterministic HubSpot sync
// itself) always runs regardless of this setting — only the questionnaire
// email is gated. When auto-send is off, questionnaire_token/
// questionnaire_sent_at are left null on the new row instead of being set
// optimistically, so the row doesn't falsely look "already sent".

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { getHubspotContacts } from '../_shared/hubspot.ts';
import { sendGmail, bodyWithLink, LINK_MARKER } from '../_shared/gmail.ts';
import { requireCredential } from '../_shared/credentials.ts';
import { isAutoSendEnabled } from '../_shared/autoSend.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();
    console.log('CHECKPOINT: before requireCredential hubspot');
    const hubspotCred = await requireCredential(supabaseAdmin, 'hubspot', 'HubSpot');
    console.log('CHECKPOINT: after requireCredential hubspot');
    console.log('CHECKPOINT: before requireCredential gmail');
    const gmailCred = await requireCredential(supabaseAdmin, 'gmail', 'Gmail');
    console.log('CHECKPOINT: after requireCredential gmail');
    if (!gmailCred.meta?.email) throw new Error('Gmail is connected but has no account email on file — reconnect in Settings.');

    console.log('CHECKPOINT: before isAutoSendEnabled');
    const autoSend = await isAutoSendEnabled(supabaseAdmin);
    console.log('CHECKPOINT: after isAutoSendEnabled');
    if (!autoSend) {
      await logAutomationFailure(
        supabaseAdmin,
        'sync-hubspot-leads',
        'Auto-send is disabled in Settings — new leads from this sync will not be emailed a questionnaire link automatically.'
      );
    }

    console.log('CHECKPOINT: before getHubspotContacts');
    const contacts = await getHubspotContacts(hubspotCred.value);
    console.log('CHECKPOINT: after getHubspotContacts');

    console.log('CHECKPOINT: before leads select');
    const { data: existingLeads } = await supabaseAdmin
      .from('leads')
      .select('id, email, hubspot_contact_id, contact_name, business_name');
    console.log('CHECKPOINT: after leads select');
    const existing = existingLeads || [];

    const baseUrl = (Deno.env.get('QUESTIONNAIRE_BASE_URL') || '').replace(/\/$/, '');
    let created = 0;
    const errors: string[] = [];

    for (const c of contacts) {
      const props = c.properties || {};
      const email = (props.email || '').toLowerCase();
      if (!email) continue;

      const alreadyExists = existing.some(
        (l: any) =>
          (l.hubspot_contact_id && l.hubspot_contact_id === c.id) ||
          (l.email || '').toLowerCase() === email
      );
      if (alreadyExists) {
        // Informational, not an error — this is expected whenever the sync
        // runs again and a contact was already pulled in. Logged (rather
        // than a bare silent `continue`) so it's visible in Settings ->
        // Integrations -> Automation Activity, not just inferred from the
        // absence of a new lead.
        await logAutomationFailure(
          supabaseAdmin,
          'sync-hubspot-leads',
          `Skipped duplicate: ${email} already exists as a lead (HubSpot contact ${c.id})`
        );
        continue;
      }

      const token = crypto.randomUUID();
      const contactName = `${props.firstname || ''} ${props.lastname || ''}`.trim();
      const businessName = props.company || contactName || 'HubSpot Contact';

      // Soft/inverse duplicate check: same person+business under a DIFFERENT
      // email than any existing lead. HubSpot is the source of truth for
      // contacts, so this is never suppressed like the exact-match case above
      // — the contact is inserted as usual, just flagged for a human to
      // review (see duplicate_flag in supabase_schema_v7.sql).
      const inverseMatch = contactName
        ? existing.find(
            (l: any) =>
              (l.contact_name || '').trim().toLowerCase() === contactName.toLowerCase() &&
              (l.business_name || '').trim().toLowerCase() === businessName.toLowerCase()
          )
        : null;
      if (inverseMatch) {
        await logAutomationFailure(
          supabaseAdmin,
          'sync-hubspot-leads',
          `Possible duplicate with a different email: ${email} (HubSpot contact ${c.id}) matches existing lead "${inverseMatch.business_name}" by name — inserted anyway, flagged for review`,
          inverseMatch.id
        );
      }

      console.log(`CHECKPOINT: before insert (${email})`);
      const { data: inserted, error: insertError } = await supabaseAdmin
        .from('leads')
        .insert([{
          business_name: businessName,
          contact_name: contactName,
          email: props.email,
          phone: props.phone || '',
          source: 'HubSpot', // HubSpot is the single lead-entry point now — ad platforms feed HubSpot directly on HubSpot's side
          stage: 'New Lead',
          practice_type: 'Other',
          location: '',
          proposal_value: 0,
          last_contact: new Date().toISOString().slice(0, 10),
          notes: 'Auto-synced from HubSpot; questionnaire sent.',
          hubspot_contact_id: c.id,
          questionnaire_token: autoSend ? token : null,
          questionnaire_sent_at: autoSend ? new Date().toISOString() : null,
          duplicate_flag: inverseMatch ? inverseMatch.id : null,
        }])
        .select()
        .single();
      console.log(`CHECKPOINT: after insert (${email})`);

      if (insertError || !inserted) {
        errors.push(`insert failed for ${email}: ${insertError?.message}`);
        await logAutomationFailure(supabaseAdmin, 'sync-hubspot-leads', `Could not create lead for HubSpot contact ${email}: ${insertError?.message}`);
        continue;
      }
      created++;

      if (!autoSend) continue;

      try {
        const link = `${baseUrl}/questionnaire.html?lead=${inserted.id}&token=${token}`;
        const subject = 'A few quick questions before we chat';
        const body = `Hi ${contactName || 'there'},

Thanks for reaching out! Before our call, it'd help to know a bit more about your practice and what you're looking for.

Could you ${LINK_MARKER} answer a few quick questions? It only takes about 3 minutes.

Talk soon,
Social Practice`;

        console.log(`CHECKPOINT: before sendGmail (${email})`);
        await sendGmail(gmailCred.value, gmailCred.meta.email, props.email, subject, bodyWithLink(body, link));
        console.log(`CHECKPOINT: after sendGmail (${email})`);
      } catch (mailErr) {
        errors.push(`email failed for ${email}: ${String(mailErr)}`);
        await logAutomationFailure(
          supabaseAdmin,
          'sync-hubspot-leads',
          `Lead was created from HubSpot, but the questionnaire email failed to send: ${String(mailErr)}`,
          inserted.id
        );
      }
    }

    return new Response(JSON.stringify({ ok: true, created, errors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    try { await logAutomationFailure(getSupabaseAdmin(), 'sync-hubspot-leads', `Run failed entirely: ${String(e)}`); } catch { /* logging itself failed, nothing more to do */ }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
