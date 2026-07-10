// Scheduled via pg_cron (see DEPLOYMENT.md). Pulls new HubSpot contacts,
// creates a lead + a unique questionnaire link for each, and emails it.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { getHubspotContacts } from '../_shared/hubspot.ts';
import { callClaude } from '../_shared/claude.ts';
import { getVoiceProfileBlock, buildSystemPrompt } from '../_shared/voice.ts';
import { sendGmail } from '../_shared/gmail.ts';
import { requireCredential } from '../_shared/credentials.ts';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const hubspotCred = await requireCredential(supabaseAdmin, 'hubspot', 'HubSpot');
    const anthropicCred = await requireCredential(supabaseAdmin, 'anthropic', 'Claude (Anthropic)');
    const gmailCred = await requireCredential(supabaseAdmin, 'gmail', 'Gmail');
    if (!gmailCred.meta?.email) throw new Error('Gmail is connected but has no account email on file — reconnect in Settings.');

    const contacts = await getHubspotContacts(hubspotCred.value);

    const { data: existingLeads } = await supabaseAdmin
      .from('leads')
      .select('id, email, hubspot_contact_id');
    const existing = existingLeads || [];

    const baseUrl = (Deno.env.get('QUESTIONNAIRE_BASE_URL') || '').replace(/\/$/, '');
    const voiceBlock = await getVoiceProfileBlock(supabaseAdmin);
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
      if (alreadyExists) continue;

      const token = crypto.randomUUID();
      const contactName = `${props.firstname || ''} ${props.lastname || ''}`.trim();

      const { data: inserted, error: insertError } = await supabaseAdmin
        .from('leads')
        .insert([{
          business_name: props.company || contactName || 'HubSpot Contact',
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
          questionnaire_token: token,
          questionnaire_sent_at: new Date().toISOString(),
        }])
        .select()
        .single();

      if (insertError || !inserted) {
        errors.push(`insert failed for ${email}: ${insertError?.message}`);
        continue;
      }

      try {
        const link = `${baseUrl}/questionnaire.html?lead=${inserted.id}&token=${token}`;
        const draft = await callClaude(
          anthropicCred.value,
          buildSystemPrompt(
            `Task: Draft a short, warm email to a brand-new lead asking them to fill out a quick 3-minute questionnaire before their strategy call. Include this exact link on its own line: ${link}`,
            voiceBlock
          ),
          `New lead: ${contactName || 'there'} from ${props.company || 'their practice'}. Write ONLY the email — first line "Subject: ..." then the body.`
        );
        const subjectMatch = draft.match(/^Subject:\s*(.+)$/mi);
        const subject = subjectMatch ? subjectMatch[1].trim() : 'A few quick questions before we chat';
        const body = draft.replace(/^Subject:.*$/mi, '').trim();

        await sendGmail(gmailCred.value, gmailCred.meta.email, props.email, subject, body);
        created++;
      } catch (mailErr) {
        errors.push(`email failed for ${email}: ${String(mailErr)}`);
      }
    }

    return new Response(JSON.stringify({ ok: true, created, errors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
