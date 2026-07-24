import { useEffect, useState } from 'react';
import { Star, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';

const sgDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' });
const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

type ReviewRow = {
  id: string;
  rating: number;
  comment: string | null;
  provider_response: string | null;
  provider_responded_at: string | null;
  created_at: string;
  parent_name: string;
  activity_title: string;
};

export default function ReviewsPage() {
  const { provider, role } = useAuth();
  const canManage = role === 'owner' || role === 'manager';

  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'unanswered'>('all');

  async function load() {
    if (!provider) return;
    setLoading(true);
    const { data: acts } = await supabase.from('activities').select('id, title').eq('provider_id', provider.id);
    const titleOf = new Map((acts ?? []).map((a) => [a.id, a.title]));
    const ids = [...titleOf.keys()];
    if (!ids.length) { setReviews([]); setLoading(false); return; }

    const { data } = await supabase
      .from('reviews')
      .select('id, rating, comment, provider_response, provider_responded_at, created_at, activity_id, user_id')
      .in('activity_id', ids)
      .order('created_at', { ascending: false });

    const userIds = [...new Set((data ?? []).map((r) => r.user_id))];
    const nameById = new Map<string, string>();
    if (userIds.length) {
      const { data: profiles } = await supabase.from('parent_profiles').select('id, full_name').in('id', userIds);
      (profiles ?? []).forEach((p) => nameById.set(p.id, p.full_name ?? 'A parent'));
    }

    setReviews(
      (data ?? []).map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        provider_response: r.provider_response,
        provider_responded_at: r.provider_responded_at,
        created_at: r.created_at,
        parent_name: nameById.get(r.user_id) ?? 'A parent',
        activity_title: titleOf.get(r.activity_id) ?? 'Activity',
      }))
    );
    setLoading(false);
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [provider]);

  async function submitResponse(reviewId: string) {
    const text = (drafts[reviewId] ?? '').trim();
    if (!text) return;
    setSaving(reviewId);
    const { error } = await supabase.rpc('respond_to_review', { p_review_id: reviewId, p_response: text });
    setSaving(null);
    if (error) return;
    setDrafts((d) => { const next = { ...d }; delete next[reviewId]; return next; });
    load();
  }

  const visible = filter === 'unanswered' ? reviews.filter((r) => !r.provider_response) : reviews;
  const avgRating = reviews.length ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1) : '—';
  const unansweredCount = reviews.filter((r) => !r.provider_response).length;

  return (
    <div className="relative">
      <div className="flex items-center justify-between px-8 py-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reviews</h1>
          <p className="text-sm text-gray-500 mt-1">What parents are saying about your classes.</p>
        </div>
      </div>

      <div className="px-8 pb-8">
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center gap-2 mb-1">
              <Star className="w-5 h-5 text-yellow-400 fill-yellow-400" />
              <span className="text-2xl font-bold text-gray-900">{avgRating}</span>
            </div>
            <div className="text-sm text-gray-500">Average rating</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="text-2xl font-bold text-gray-900 mb-1">{reviews.length}</div>
            <div className="text-sm text-gray-500">Total reviews</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="text-2xl font-bold text-gray-900 mb-1">{unansweredCount}</div>
            <div className="text-sm text-gray-500">Awaiting a response</div>
          </div>
        </div>

        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-6 w-fit">
          {(['all', 'unanswered'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={cn('px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
                filter === f ? 'bg-white text-[#E91E63] shadow-sm' : 'text-gray-600 hover:text-gray-900')}>
              {f === 'all' ? 'All reviews' : `Unanswered (${unansweredCount})`}
            </button>
          ))}
        </div>

        {loading && <div className="text-sm text-gray-400">Loading reviews…</div>}
        {!loading && visible.length === 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-400">
            {filter === 'unanswered' ? "You're all caught up — no unanswered reviews." : 'No reviews yet.'}
          </div>
        )}

        <div className="space-y-4">
          {visible.map((r) => (
            <div key={r.id} className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-pink-100 text-pink-600 flex items-center justify-center text-sm font-bold flex-shrink-0">
                  {initials(r.parent_name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium text-gray-900 text-sm">{r.parent_name}</span>
                      <span className="text-sm text-gray-500"> · {r.activity_title}</span>
                    </div>
                    <span className="text-xs text-gray-400">{sgDate(r.created_at)}</span>
                  </div>
                  <div className="flex items-center gap-0.5 mt-1">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Star key={i} className={cn('w-3.5 h-3.5', i < r.rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-200')} />
                    ))}
                  </div>
                  {r.comment && <p className="mt-2 text-sm text-gray-700">{r.comment}</p>}

                  {r.provider_response ? (
                    <div className="mt-3 rounded-lg bg-gray-50 p-3">
                      <div className="text-xs font-medium text-gray-500 mb-1">
                        Your response{r.provider_responded_at ? ` · ${sgDate(r.provider_responded_at)}` : ''}
                      </div>
                      <p className="text-sm text-gray-700">{r.provider_response}</p>
                    </div>
                  ) : canManage ? (
                    <div className="mt-3 flex gap-2">
                      <input
                        value={drafts[r.id] ?? ''}
                        onChange={(e) => setDrafts({ ...drafts, [r.id]: e.target.value })}
                        placeholder="Write a reply…"
                        className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-200"
                      />
                      <Button
                        onClick={() => submitResponse(r.id)}
                        disabled={saving === r.id || !(drafts[r.id] ?? '').trim()}
                        className="gradient-primary text-white rounded-lg hover:opacity-90 gap-2 flex-shrink-0"
                      >
                        <MessageSquare className="w-4 h-4" /> {saving === r.id ? 'Sending…' : 'Reply'}
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-gray-400">Only the business owner or manager can respond.</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
