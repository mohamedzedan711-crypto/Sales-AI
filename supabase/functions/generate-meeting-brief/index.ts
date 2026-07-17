// Callable directly from the app (anon key, same pattern as
// send-booking-email) whenever a meeting gets booked through a path that
// doesn't already trigger it automatically — e.g. the manual "Book Call"
// button in the Sales Pipeline. send-booking-email (the qualification
// funnel's automated booking path) calls generateMeetingPrepBrief directly
// instead of hitting this over HTTP, since they run in the same Deno
// runtime — this function exists for the client-triggered case.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { requireCredential } from '../_shared/credentials.ts';
import { generateMeetingPrepBrief } from '../_shared/meetingPrep.ts';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { leadId } = await req.json();
    if (!leadId) throw new Error('leadId is required');

    const supabaseAdmin = getSupabaseAdmin();
    const anthropicCred = await requireCredential(supabaseAdmin, 'anthropic', 'Claude (Anthropic)');

    const brief = await generateMeetingPrepBrief(supabaseAdmin, anthropicCred.value, leadId);

    return new Response(JSON.stringify({ ok: true, brief }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
