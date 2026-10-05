import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, WixFormQuestion } from '@/types/database';
import { questionsForParent, rememberedAnswers, type PastFormAnswers } from './event-form';

const HISTORY = 15;

/**
 * What a parent already told other organisers about one child, matched to this event's questions —
 * the prefill for the booking page (see rememberedAnswers for what carries over and how it is matched).
 * Nothing new is stored: it reads the answers already kept on that parent's own earlier ticket orders and
 * RSVPs. Always filtered by BOTH the parent and the child, so neither another parent's nor another
 * child's answers can ever come back.
 */
export async function loadRememberedAnswers(
  admin: SupabaseClient<Database>,
  params: { userId: string; eventId: string; childId: string }
): Promise<Record<string, string>> {
  const { userId, eventId, childId } = params;
  const { data: event } = await admin.from('wix_events').select('form_questions').eq('id', eventId).maybeSingle();
  const current = (event?.form_questions ?? []) as WixFormQuestion[];
  // Nothing on this form is a free-text question we could remember: skip the history lookups.
  if (!questionsForParent(current).some((q) => !q.options?.length && !q.multi)) return {};

  const [{ data: orders }, { data: rsvps }] = await Promise.all([
    admin
      .from('event_ticket_orders')
      .select('event_id, form_response, created_at')
      .eq('user_id', userId)
      .eq('child_id', childId)
      .order('created_at', { ascending: false })
      .limit(HISTORY),
    admin
      .from('event_rsvps')
      .select('event_id, form_response, created_at')
      .eq('user_id', userId)
      .eq('child_id', childId)
      .order('created_at', { ascending: false })
      .limit(HISTORY),
  ]);
  const past = [...(orders ?? []), ...(rsvps ?? [])]
    .filter((r) => r.form_response && Object.keys(r.form_response).length > 0)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, HISTORY);
  if (!past.length) return {};

  const { data: pastEvents } = await admin
    .from('wix_events')
    .select('id, form_questions')
    .in('id', [...new Set(past.map((r) => r.event_id))]);
  const questionsByEvent = new Map((pastEvents ?? []).map((e) => [e.id, (e.form_questions ?? []) as WixFormQuestion[]]));

  const history: PastFormAnswers[] = past.map((r) => ({
    answers: r.form_response,
    questions: questionsByEvent.get(r.event_id) ?? [],
  }));
  return rememberedAnswers(current, history);
}
