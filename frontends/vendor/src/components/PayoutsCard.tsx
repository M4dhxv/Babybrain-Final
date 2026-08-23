import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock, Lock, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';

/** Mirrors ConnectStatus in lib/stripe-connect.ts on the backend. */
export interface ConnectStatus {
  state: 'not_connected' | 'incomplete' | 'action_required' | 'pending' | 'active';
  account_id: string | null;
  details_submitted: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  disabled_reason: string | null;
  requirements_due: string[];
  past_due: string[];
  pending_verification: string[];
  deadline: string | null;
  payout_interval: string | null;
  bank_last4: string | null;
  bank_name: string | null;
  balance: { currency: string; available: number; pending: number } | null;
}

/**
 * Stripe writes requirements as dotted API paths ("company.tax_id"). Show the
 * handful we see most often in plain English, and fall back to a readable
 * version of the key rather than hiding anything we haven't mapped.
 */
const REQUIREMENT_LABELS: Record<string, string> = {
  'business_profile.mcc': 'Industry you operate in',
  'business_profile.url': 'Business website',
  'business_profile.product_description': 'What you sell',
  'business_type': 'Whether you’re a company or an individual',
  'company.address': 'Business address',
  'company.directors_provided': 'Confirmation of your directors',
  'company.name': 'Registered business name',
  'company.owners_provided': 'Confirmation of your owners',
  'company.ownership_exemption_reason': 'Ownership declaration',
  'company.phone': 'Business phone number',
  'company.tax_id': 'UEN / tax ID',
  'company.verification.document': 'Business registration document',
  'external_account': 'Bank account for payouts',
  'tos_acceptance': 'Accepting Stripe’s terms',
};

/**
 * Stripe names a requirement per field ("representative.address.line1",
 * "representative.address.postal_code", "representative.dob.day"), which
 * reads like an API dump and repeats itself. Collapse each family down to
 * the one thing the vendor actually has to go and enter.
 */
const FIELD_GROUPS: Array<[RegExp, string]> = [
  [/\.address(\.|$)/, 'address'],
  [/\.dob(\.|$)/, 'date of birth'],
  [/\.verification\.additional_document(\.|$)/, 'proof of address'],
  [/\.verification(\.|$)/, 'identity document'],
  [/\.(first_name|last_name|full_name_aliases)$/, 'full name'],
  [/\.id_number$/, 'NRIC / FIN'],
  [/\.email$/, 'email address'],
  [/\.phone$/, 'phone number'],
  [/\.political_exposure$/, 'political-exposure declaration'],
  [/\.relationship\./, 'role in the business'],
];

const WHOSE: Record<string, string> = {
  individual: 'Your',
  representative: 'Your',
  person: 'Your',
  owners: 'Each owner’s',
  directors: 'Each director’s',
  executives: 'Each executive’s',
  company: 'Your business’s',
};

function requirementLabel(key: string): string {
  if (REQUIREMENT_LABELS[key]) return REQUIREMENT_LABELS[key];

  const prefix = key.split('.')[0];
  const group = FIELD_GROUPS.find(([re]) => re.test(key));
  if (group && WHOSE[prefix]) return `${WHOSE[prefix]} ${group[1]}`;

  // Anything unmapped still gets shown, just made readable:
  // "owners.full_name_aliases" → "Owners full name aliases".
  const words = key.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Collapse the per-field requirements into a de-duplicated to-do list. */
function requirementList(keys: string[]): string[] {
  return Array.from(new Set(keys.map(requirementLabel)));
}

const DISABLED_REASONS: Record<string, string> = {
  'requirements.past_due': 'Stripe needs more information before it can pay you.',
  'requirements.pending_verification': 'Stripe is verifying the details you submitted.',
  'listed': 'Stripe is reviewing this account.',
  'platform_paused': 'Payouts are paused by BabyBrain — get in touch and we’ll sort it out.',
  'rejected.fraud': 'Stripe rejected this account. Contact Stripe support.',
  'rejected.terms_of_service': 'Stripe rejected this account for a terms-of-service issue.',
  'under_review': 'Stripe is reviewing this account.',
};

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-SG', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);

const sgDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Stripe Connect payouts for the business: onboarding, verification progress
 * and the Express dashboard. Status is read live from Stripe on every visit
 * — including the trip back from onboarding — so it stays right even when
 * the `account.updated` webhook is slow or never arrives.
 */
export default function PayoutsCard() {
  const { provider, role, refreshProvider } = useAuth();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Captured once: the effect below strips ?connect= from the URL as soon
  // as the status has been re-read, so reading `params` at render time
  // would never see it.
  const [justReturned] = useState(() => params.get('connect') === 'done');

  const load = useCallback(async () => {
    if (!provider) return;
    setError(null);
    try {
      const { status } = await apiGet<{ status: ConnectStatus }>(
        `/api/vendor/stripe/connect?provider_id=${provider.id}`
      );
      setStatus(status);
      // The GET syncs providers.payouts_enabled; pull the row back in so the
      // rest of the portal agrees with this card.
      if (status.payouts_enabled !== provider.payouts_enabled) await refreshProvider();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your payout status.');
    } finally {
      setLoading(false);
    }
  }, [provider, refreshProvider]);

  useEffect(() => {
    void load();
  }, [load]);

  // Clear the ?connect= marker once we've re-read the status, so a refresh
  // doesn't keep claiming they've just come back from Stripe.
  useEffect(() => {
    if (!loading && params.get('connect')) {
      const next = new URLSearchParams(params);
      next.delete('connect');
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  async function openStripe() {
    if (!provider) return;
    setError(null);
    setBusy(true);
    try {
      const { url } = await apiPost<{ url?: string }>('/api/vendor/stripe/connect', {
        provider_id: provider.id,
      });
      if (url) window.location.href = url;
      else setError('Could not open Stripe just now — please try again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payments aren’t set up on this account yet.');
    } finally {
      setBusy(false);
    }
  }

  const state = status?.state ?? 'not_connected';
  const isOwner = role === 'owner';

  const badge = {
    active: { className: 'bg-green-300 text-green-800', label: 'Active — payouts on' },
    pending: { className: 'bg-blue-100 text-blue-800', label: 'Verifying with Stripe' },
    action_required: { className: 'bg-yellow-300 text-yellow-800', label: 'Action needed' },
    incomplete: { className: 'bg-yellow-300 text-yellow-800', label: 'Setup unfinished' },
    not_connected: { className: 'bg-gray-100 text-gray-600', label: 'Not connected' },
  }[state];

  const cta = {
    active: 'Manage payouts',
    pending: 'View payout account',
    action_required: 'Finish verification',
    incomplete: 'Continue setup',
    not_connected: 'Connect payouts',
  }[state];

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
            <span className="text-purple-600 font-bold text-sm">S</span>
          </div>
          <div>
            <h3 className="font-semibold text-gray-900">Stripe payouts</h3>
            <p className="text-xs text-gray-500">Where your class payments land.</p>
          </div>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          title="Refresh status from Stripe"
          className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {justReturned && state !== 'active' && !loading && (
        <div className="mb-4 rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
          Thanks — we’ve picked up where Stripe left off. Anything still outstanding is listed below.
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-xs text-gray-500 mb-1">Payout account status</div>
          {loading && !status ? (
            <span className="inline-flex items-center px-2.5 py-1 bg-gray-100 text-gray-500 text-xs font-medium rounded-full">
              Checking…
            </span>
          ) : (
            <span className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full ${badge.className}`}>
              {state === 'active' && <CheckCircle2 className="w-3 h-3" />}
              {state === 'pending' && <Clock className="w-3 h-3" />}
              {(state === 'action_required' || state === 'incomplete') && <AlertTriangle className="w-3 h-3" />}
              {badge.label}
            </span>
          )}
        </div>
        {isOwner ? (
          <Button
            onClick={openStripe}
            disabled={busy || loading}
            variant="outline"
            className="rounded-lg border-gray-300 text-gray-700 hover:bg-gray-50 text-sm"
          >
            {busy ? 'Opening…' : cta}
          </Button>
        ) : (
          <span className="text-xs text-gray-500">Only an owner can change this.</span>
        )}
      </div>

      {/* Payouts are live — show the account they go to and what's in flight. */}
      {state === 'active' && status && (
        <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-xs text-gray-500">Paid out to</div>
            <div className="font-medium text-gray-900">
              {status.bank_last4 ? `${status.bank_name ?? 'Bank account'} ••••${status.bank_last4}` : 'Your Stripe balance'}
            </div>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-xs text-gray-500">Schedule</div>
            <div className="font-medium text-gray-900 capitalize">{status.payout_interval ?? 'Automatic'}</div>
          </div>
          {status.balance && (
            <>
              <div className="rounded-lg bg-gray-50 px-3 py-2">
                <div className="text-xs text-gray-500">Available</div>
                <div className="font-medium text-gray-900">{money(status.balance.available, status.balance.currency)}</div>
              </div>
              <div className="rounded-lg bg-gray-50 px-3 py-2">
                <div className="text-xs text-gray-500">On the way</div>
                <div className="font-medium text-gray-900">{money(status.balance.pending, status.balance.currency)}</div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Stripe is still verifying — nothing for the vendor to do. */}
      {state === 'pending' && (
        <p className="mb-4 text-xs text-gray-600">
          Everything’s submitted. Stripe usually finishes verifying within a business day, and payouts switch on
          automatically — we’ll notify you.
        </p>
      )}

      {/* Outstanding requirements, in plain English. */}
      {status && status.requirements_due.length > 0 && (
        <div className="mb-4 rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-3">
          <div className="text-xs font-semibold text-yellow-900 mb-2">
            Stripe still needs{status.deadline ? ` this by ${sgDate(status.deadline)}` : ''}:
          </div>
          <ul className="space-y-1">
            {requirementList(status.requirements_due).slice(0, 6).map((label) => (
              <li key={label} className="text-xs text-yellow-900 flex items-start gap-1.5">
                <span className="mt-1 w-1 h-1 rounded-full bg-yellow-600 flex-shrink-0" />
                {label}
              </li>
            ))}
            {requirementList(status.requirements_due).length > 6 && (
              <li className="text-xs text-yellow-800">
                +{requirementList(status.requirements_due).length - 6} more — Stripe will walk you through them.
              </li>
            )}
          </ul>
        </div>
      )}

      {status?.disabled_reason && DISABLED_REASONS[status.disabled_reason] && (
        <p className="mb-4 text-xs text-gray-600">{DISABLED_REASONS[status.disabled_reason]}</p>
      )}

      {state === 'not_connected' && (
        <p className="mb-4 text-xs text-gray-600">
          Connect a Stripe account to take paid bookings. Parents pay at checkout, BabyBrain’s commission comes off
          automatically, and the rest is paid into your bank account.
        </p>
      )}

      {/* Until payouts are on, paid bookings still work — the money is just
          collected by BabyBrain and settled to the vendor separately. Saying
          so avoids the impression that paid classes are broken. */}
      {state !== 'active' && (
        <p className="mb-4 text-xs text-gray-600">
          Paid bookings still work in the meantime — BabyBrain collects them and settles with you directly.
        </p>
      )}

      <div className="flex items-center gap-2 text-xs text-gray-500">
        <Lock className="w-3.5 h-3.5" />
        Your bank and identity details go straight to Stripe — BabyBrain never sees them.
      </div>
    </div>
  );
}
