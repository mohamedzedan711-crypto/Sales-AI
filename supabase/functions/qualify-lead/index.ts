// Triggered by a Supabase Database Webhook on INSERT to questionnaire_responses
// (see DEPLOYMENT.md for the exact webhook setup). Scores the lead and writes
// qualified / qualification_score / qualification_reason back to `leads`.
//
// Qualification thresholds live entirely in the `qualification_config` table
// (edited from Settings) — never hardcoded here. Scoring is fully
// deterministic (no LLM call): budget below the floor always disqualifies,
// budget at/above the ideal threshold is flagged as priority in the reason
// text, everything in between gets a score interpolated between the two.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { logAutomationFailure } from '../_shared/automationLog.ts';

function parseBudget(band: string | null | undefined): number | null {
  if (!band) return null;
  if (/not sure/i.test(band)) return null;
  const nums = band.match(/[\d,]+/g);
  if (!nums || !nums.length) return null;
  // Conservative: use the lower bound of a range (or the single number for "$X+/mo").
  return Number(nums[0].replace(/,/g, ''));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const payload = await req.json();
    const response = payload.record;
    if (!response) throw new Error('No record in webhook payload');

    const supabaseAdmin = getSupabaseAdmin();

    const { data: lead } = await supabaseAdmin
      .from('leads')
      .select('*')
      .eq('questionnaire_token', response.token)
      .maybeSingle();
    if (!lead) throw new Error('No lead matches this questionnaire token — ignoring.');

    const { data: config } = await supabaseAdmin
      .from('qualification_config')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    const minFloor = Number(config?.min_budget_floor || 0);
    const idealThreshold = Number(config?.ideal_budget_threshold || 0);
    const budget = parseBudget(response.monthly_budget_band);

    // Fully deterministic scoring — qualification_config is the sole source of truth.
    let qualified: boolean;
    let score: number;
    let reason: string;

    if (budget === null) {
      qualified = false;
      score = 0;
      reason = 'Incomplete — no budget provided.';
    } else if (budget < minFloor) {
      qualified = false;
      score = minFloor > 0 ? Math.max(0, Math.round((budget / minFloor) * 40)) : 0;
      reason = `Budget of $${budget}/mo is below the $${minFloor} minimum.`;
    } else {
      qualified = true;
      const priority = idealThreshold > 0 && budget >= idealThreshold;
      score = idealThreshold > minFloor
        ? Math.min(100, Math.round(50 + ((budget - minFloor) / (idealThreshold - minFloor)) * 50))
        : 100;
      reason = priority
        ? `Budget of $${budget}/mo meets the $${idealThreshold} priority threshold.`
        : `Budget of $${budget}/mo clears the $${minFloor} minimum.`;
      if (response.approves_spend === 'someone_else') {
        reason += ' Note: someone else approves spend.';
      }
    }

    await supabaseAdmin
      .from('leads')
      .update({
        qualified,
        qualification_score: score,
        qualification_reason: reason,
        questionnaire_submitted_at: new Date().toISOString(),
        business_name: response.business_name || lead.business_name,
        contact_name: response.contact_name || lead.contact_name,
        email: response.email || lead.email,
        practice_type:
          lead.practice_type && lead.practice_type !== 'Other'
            ? lead.practice_type
            : response.practice_type || lead.practice_type,
      })
      .eq('id', lead.id);

    return new Response(JSON.stringify({ ok: true, qualified, score }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    try { await logAutomationFailure(getSupabaseAdmin(), 'qualify-lead', `Run failed entirely (lead was not scored): ${String(e)}`); } catch { /* logging itself failed, nothing more to do */ }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
