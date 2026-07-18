// Triggered by a Supabase Database Webhook on INSERT to questionnaire_responses
// (see DEPLOYMENT.md for the exact webhook setup). Scores the lead and writes
// qualified / qualification_score / qualification_reason back to `leads`.
//
// Qualification thresholds live entirely in the `qualification_config` table
// (edited from Settings) — never hardcoded here. Claude produces the score
// and the human-readable reason; the hard pass/fail rules are ALSO enforced
// deterministically below so they can never depend on the model getting it
// right — this is the belt-and-suspenders design called out in the plan.

import { getSupabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { callClaude, stripJsonFence } from '../_shared/claude.ts';
import { requireCredential } from '../_shared/credentials.ts';
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
    const anthropicCred = await requireCredential(supabaseAdmin, 'anthropic', 'Claude (Anthropic)');

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

    const claudeText = await callClaude(
      anthropicCred.value,
      `You are scoring a lead qualification questionnaire for a boutique medical-aesthetics marketing agency. Apply these rules exactly:
- Minimum monthly budget floor: $${minFloor}. If their budget is below this, qualified MUST be false.
- Ideal/priority monthly budget threshold: $${idealThreshold}. If budget is at or above this, set priority true.
- "Someone else approves spend" (approves_spend = "someone_else") is a soft flag only — never auto-disqualify for it, just mention it as a caveat in the reason.
- "Just exploring" on the start-timeline question alone should NOT disqualify if budget otherwise clears the floor.
- If budget data is missing or unclear, qualified MUST be false and the reason must say the info was incomplete — never guess a number.
Return ONLY valid JSON, no markdown fences, with exactly these keys: qualified (boolean), score (integer 0-100), priority (boolean), reason (one specific sentence referencing their actual answers).`,
      `Questionnaire answers:\n${JSON.stringify(response, null, 2)}\n\nParsed monthly budget (best-effort numeric, null if unclear): ${budget}`
    );

    let parsed: any;
    try {
      parsed = JSON.parse(stripJsonFence(claudeText));
    } catch {
      parsed = { qualified: false, score: 0, priority: false, reason: 'Could not parse qualification result.' };
      await logAutomationFailure(
        supabaseAdmin,
        'qualify-lead',
        `Claude did not return valid JSON for this lead's qualification — scored 0/not-qualified as a safe default instead of guessing. Worth a manual re-check.`,
        lead.id
      );
    }

    // Deterministic hard-rule enforcement (source of truth: qualification_config).
    let qualified = !!parsed.qualified;
    let reason = parsed.reason || '';
    if (budget === null) {
      qualified = false;
      reason = 'Incomplete — no budget provided.';
    } else if (budget < minFloor) {
      qualified = false;
      reason = `Budget of $${budget}/mo is below the $${minFloor} minimum.`;
    }

    await supabaseAdmin
      .from('leads')
      .update({
        qualified,
        qualification_score: parsed.score ?? null,
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

    return new Response(JSON.stringify({ ok: true, qualified, score: parsed.score }), {
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
