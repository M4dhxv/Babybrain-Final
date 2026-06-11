'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type {
  ActivityCategory,
  Child,
  Gender,
  PreferredDay,
  PreferredTime,
} from '@/types/database';
import { formatChildAge } from '@/types/database';

const DAYS: [PreferredDay, string][] = [
  ['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'],
  ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun'],
];
const TIMES: [PreferredTime, string][] = [
  ['morning', 'Morning'], ['afternoon', 'Afternoon'], ['evening', 'Evening'],
];

function TogglePills<T extends string>({
  options,
  selected,
  onToggle,
}: {
  options: [T, string][];
  selected: T[];
  onToggle: (value: T) => void;
}) {
  return (
    <div className="pill-row">
      {options.map(([value, label]) => (
        <span
          key={value}
          className={`pill clickable${selected.includes(value) ? ' selected' : ''}`}
          onClick={() => onToggle(value)}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const supabase = createClient();

  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<ActivityCategory[]>([]);

  // Step 1 — parent info + preferences
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [days, setDays] = useState<PreferredDay[]>([]);
  const [times, setTimes] = useState<PreferredTime[]>([]);
  const [budgetMin, setBudgetMin] = useState('');
  const [budgetMax, setBudgetMax] = useState('');
  const [interests, setInterests] = useState<string[]>([]);

  // Step 2 — children
  const [children, setChildren] = useState<Child[]>([]);
  const [childName, setChildName] = useState('');
  const [childDob, setChildDob] = useState('');
  const [childGender, setChildGender] = useState<Gender>('unspecified');
  const [childInterests, setChildInterests] = useState<string[]>([]);
  const [childNotes, setChildNotes] = useState('');

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const [{ data: cats }, { data: profile }, { data: prefs }, { data: kids }] =
        await Promise.all([
          supabase.from('activity_categories').select('*').order('sort_order'),
          supabase.from('parent_profiles').select('*').eq('id', user.id).single(),
          supabase.from('user_preferences').select('*').eq('user_id', user.id).single(),
          supabase.from('children').select('*').order('created_at'),
        ]);

      setCategories(cats ?? []);
      if (profile) {
        setFullName(profile.full_name);
        setEmail(profile.email);
        setPhone(profile.phone ?? '');
        setPostalCode(profile.postal_code ?? '');
      }
      if (prefs) {
        setDays(prefs.preferred_days);
        setTimes(prefs.preferred_times);
        setBudgetMin(prefs.budget_min?.toString() ?? '');
        setBudgetMax(prefs.budget_max?.toString() ?? '');
        setInterests(prefs.interests);
      }
      setChildren(kids ?? []);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  async function saveStep1(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    // Geocode the postal code (best-effort — onboarding continues without it)
    let latitude: number | null = null;
    let longitude: number | null = null;
    try {
      const res = await fetch('/api/geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postal_code: postalCode }),
      });
      if (res.ok) {
        const geo = await res.json();
        latitude = geo.latitude;
        longitude = geo.longitude;
      }
    } catch {
      /* keep nulls */
    }

    const { error: profileError } = await supabase
      .from('parent_profiles')
      .update({
        full_name: fullName,
        phone: phone || null,
        postal_code: postalCode || null,
        latitude,
        longitude,
      })
      .eq('id', user.id);

    const { error: prefsError } = await supabase
      .from('user_preferences')
      .update({
        preferred_days: days,
        preferred_times: times,
        budget_min: budgetMin ? Number(budgetMin) : null,
        budget_max: budgetMax ? Number(budgetMax) : null,
        interests,
      })
      .eq('user_id', user.id);

    setBusy(false);
    if (profileError || prefsError) {
      setError((profileError ?? prefsError)!.message);
      return;
    }
    setStep(2);
  }

  async function addChild(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data, error } = await supabase
      .from('children')
      .insert({
        parent_id: user.id,
        name: childName,
        date_of_birth: childDob,
        gender: childGender,
        interests: childInterests,
        notes: childNotes || null,
      })
      .select()
      .single();

    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setChildren([...children, data!]);
    setChildName('');
    setChildDob('');
    setChildGender('unspecified');
    setChildInterests([]);
    setChildNotes('');
  }

  async function removeChild(id: string) {
    await supabase.from('children').delete().eq('id', id);
    setChildren(children.filter((c) => c.id !== id));
  }

  async function confirmProfile() {
    setBusy(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from('parent_profiles')
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq('id', user.id);
    router.push('/matches');
    router.refresh();
  }

  const categoryOptions: [string, string][] = categories.map((c) => [c.slug, c.name]);
  const categoryName = (slug: string) =>
    categories.find((c) => c.slug === slug)?.name ?? slug;

  return (
    <main className="container">
      {error && <p className="notice error">{error}</p>}

      {step === 1 && (
        <section className="form-card auth-card" style={{ maxWidth: 640 }}>
          <h2>
            Step 1 of 3<br />
            Let’s get to know you
          </h2>
          <form onSubmit={saveStep1}>
            <div className="field">
              <input placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            </div>
            <div className="field">
              <input value={email} disabled title="Email comes from your account" />
            </div>
            <div className="field">
              <input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="field">
              <input placeholder="Postcode (6 digits)" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} pattern="\d{6}" required />
            </div>
            <span className="label">Preferred days</span>
            <TogglePills options={DAYS} selected={days} onToggle={(v) => setDays(toggle(days, v))} />
            <span className="label">Preferred times</span>
            <TogglePills options={TIMES} selected={times} onToggle={(v) => setTimes(toggle(times, v))} />
            <span className="label">Budget per session (SGD)</span>
            <div className="twocol">
              <input type="number" min="0" placeholder="Min" value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} />
              <input type="number" min="0" placeholder="Max" value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} />
            </div>
            <span className="label">Activity interests</span>
            <TogglePills options={categoryOptions} selected={interests} onToggle={(v) => setInterests(toggle(interests, v))} />
            <button className="btn" style={{ width: '100%', marginTop: 16 }} disabled={busy}>
              {busy ? 'Saving…' : 'Continue'}
            </button>
          </form>
        </section>
      )}

      {step === 2 && (
        <section className="form-card auth-card" style={{ maxWidth: 640 }}>
          <h2>
            Step 2 of 3<br />
            Tell us about your child
          </h2>
          {children.map((c) => (
            <div key={c.id} className="card" style={{ marginBottom: 10 }}>
              <strong>{c.name}</strong>, {formatChildAge(c.date_of_birth)}
              {c.interests.length > 0 && (
                <span className="muted"> · {c.interests.map(categoryName).join(', ')}</span>
              )}
              <button
                className="btn danger small"
                style={{ float: 'right' }}
                onClick={() => removeChild(c.id)}
              >
                Remove
              </button>
            </div>
          ))}
          <form onSubmit={addChild}>
            <div className="field">
              <input placeholder="Child's name" value={childName} onChange={(e) => setChildName(e.target.value)} required />
            </div>
            <div className="field">
              <input type="date" max={new Date().toISOString().slice(0, 10)} value={childDob} onChange={(e) => setChildDob(e.target.value)} required />
            </div>
            <div className="field">
              <select value={childGender} onChange={(e) => setChildGender(e.target.value as Gender)}>
                <option value="unspecified">Prefer not to say</option>
                <option value="female">Girl</option>
                <option value="male">Boy</option>
                <option value="other">Other</option>
              </select>
            </div>
            <span className="label">Interests</span>
            <TogglePills options={categoryOptions} selected={childInterests} onToggle={(v) => setChildInterests(toggle(childInterests, v))} />
            <div className="field" style={{ marginTop: 14 }}>
              <textarea rows={3} placeholder="Any preferences or notes?" value={childNotes} onChange={(e) => setChildNotes(e.target.value)} />
            </div>
            <button className="btn ghost" style={{ width: '100%' }} disabled={busy}>
              {busy ? 'Adding…' : '+ Add child'}
            </button>
          </form>
          <div className="twocol" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
            <button className="btn" disabled={children.length === 0} onClick={() => setStep(3)}>
              Continue
            </button>
          </div>
          {children.length === 0 && (
            <p className="muted" style={{ fontSize: 14 }}>Add at least one child to continue.</p>
          )}
        </section>
      )}

      {step === 3 && (
        <section className="form-card auth-card" style={{ maxWidth: 640 }}>
          <h2>
            Step 3 of 3<br />
            Here’s a preview
          </h2>
          <div className="card" style={{ marginBottom: 10 }}>
            <strong>{fullName}</strong>
            <br />
            {postalCode && <>Singapore {postalCode}<br /></>}
            {days.length > 0 && <>Prefers: {days.join(', ')} · {times.join(', ')}<br /></>}
            {budgetMax && <>Budget: up to ${budgetMax}/session<br /></>}
            {interests.length > 0 && <>Interests: {interests.map(categoryName).join(', ')}</>}
          </div>
          {children.map((c) => (
            <div key={c.id} className="card" style={{ marginBottom: 10 }}>
              <strong>{c.name}</strong>, {formatChildAge(c.date_of_birth)}
              {c.interests.length > 0 && <> · {c.interests.map(categoryName).join(', ')}</>}
            </div>
          ))}
          <button className="btn ghost" style={{ width: '100%' }} onClick={() => setStep(2)}>
            Back
          </button>
          <button
            className="btn"
            style={{ width: '100%', marginTop: 10 }}
            disabled={busy}
            onClick={confirmProfile}
          >
            {busy ? 'Matching…' : 'Show me options'}
          </button>
        </section>
      )}
    </main>
  );
}
