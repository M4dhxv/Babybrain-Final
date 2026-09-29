import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Marketing contacts, for importing into Klaviyo by hand.
 *
 * Klaviyo is managed manually (decided 29 Sep): the app never sends anything
 * to it. This hands the founder exactly who may be emailed, and who must be
 * suppressed:
 *
 *   ?list=consented  parents who ticked marketing consent (at sign-up or in
 *                    Settings) and haven't withdrawn it. Only these may be
 *                    imported.
 *   ?list=withdrawn  parents who withdrew consent (Settings → Unsubscribe or
 *                    an email footer link), recorded from 00198 onwards.
 *                    Suppress these in Klaviyo.
 *
 * Returns CSV (Klaviyo-friendly headers) by default, or `&format=json` for
 * the counts and preview in /admin.
 */

type Row = Record<string, string>;

const sgDate = (iso: string | null) =>
  iso ? new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10) : '';

function ageLabel(dob: string | null): string {
  if (!dob) return '';
  const d = new Date(dob);
  const now = new Date();
  const months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth()) - (now.getDate() < d.getDate() ? 1 : 0);
  if (months < 0) return '';
  return months < 24 ? `${months}m` : `${Math.floor(months / 12)}y`;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const toCsv = (headers: string[], rows: Row[]) =>
  [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h] ?? '')).join(','))].join('\n') + '\n';

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const list = url.searchParams.get('list') === 'withdrawn' ? 'withdrawn' : 'consented';
  const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';

  const db = createAdminClient();
  const base = db
    .from('parent_profiles')
    .select('id, full_name, email, postal_code, created_at, marketing_consent_at, marketing_consent_withdrawn_at');
  const { data: parents, error } =
    list === 'consented'
      ? await base.not('marketing_consent_at', 'is', null).order('marketing_consent_at', { ascending: false })
      : await base
          .is('marketing_consent_at', null)
          .not('marketing_consent_withdrawn_at', 'is', null)
          .order('marketing_consent_withdrawn_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const people = (parents ?? []).filter((p) => p.email);
  const ids = people.map((p) => p.id);

  let rows: Row[];
  let headers: string[];
  if (list === 'consented') {
    const [kids, prefs, subs] = ids.length
      ? await Promise.all([
          db.from('children').select('parent_id, date_of_birth').in('parent_id', ids),
          db.from('user_preferences').select('user_id, preferred_regions').in('user_id', ids),
          db.from('customer_subscriptions').select('user_id, plan, status').in('user_id', ids),
        ])
      : [{ data: [] }, { data: [] }, { data: [] }];
    const kidsBy = new Map<string, string[]>();
    for (const k of (kids.data ?? []) as { parent_id: string; date_of_birth: string | null }[]) {
      kidsBy.set(k.parent_id, [...(kidsBy.get(k.parent_id) ?? []), ageLabel(k.date_of_birth)].filter(Boolean));
    }
    const regionsBy = new Map(
      ((prefs.data ?? []) as unknown as { user_id: string; preferred_regions: string[] | null }[]).map((p) => [p.user_id, (p.preferred_regions ?? []).join('; ')])
    );
    const planBy = new Map(
      ((subs.data ?? []) as { user_id: string; plan: string; status: string }[]).map((s) => [
        s.user_id,
        s.plan === 'plus' && ['active', 'trialing'].includes(s.status) ? 'Plus' : 'Free',
      ])
    );
    headers = ['Email', 'First Name', 'Last Name', 'Consent Date', 'Signed Up', 'Plan', 'Postcode', 'Areas', 'Children', 'Child Ages'];
    rows = people.map((p) => {
      const [first, ...rest] = (p.full_name ?? '').trim().split(/\s+/);
      const ages = kidsBy.get(p.id) ?? [];
      return {
        Email: p.email as string,
        'First Name': first ?? '',
        'Last Name': rest.join(' '),
        'Consent Date': sgDate(p.marketing_consent_at),
        'Signed Up': sgDate(p.created_at),
        Plan: planBy.get(p.id) ?? 'Free',
        Postcode: p.postal_code ?? '',
        Areas: regionsBy.get(p.id) ?? '',
        Children: String(ages.length),
        'Child Ages': ages.join('; '),
      };
    });
  } else {
    headers = ['Email', 'First Name', 'Last Name', 'Withdrawn On'];
    rows = people.map((p) => {
      const [first, ...rest] = (p.full_name ?? '').trim().split(/\s+/);
      return {
        Email: p.email as string,
        'First Name': first ?? '',
        'Last Name': rest.join(' '),
        'Withdrawn On': sgDate(p.marketing_consent_withdrawn_at),
      };
    });
  }

  if (format === 'json') {
    return NextResponse.json({ list, count: rows.length, headers, preview: rows.slice(0, 5) });
  }
  const stamp = sgDate(new Date().toISOString());
  return new NextResponse(toCsv(headers, rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="babybrain-marketing-${list}-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
