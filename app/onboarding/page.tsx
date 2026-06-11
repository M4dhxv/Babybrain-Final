'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { catMeta } from '@/lib/categories';
import { initials } from '@/lib/format';
import {
  IconArrowLeft,
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconDollar,
  IconHeart,
  IconPin,
  IconSearch,
  IconShield,
  IconTrash,
  IconUser,
} from '@/components/icons';
import type {
  ActivityCategory,
  Child,
  Gender,
  PreferredDay,
  PreferredTime,
} from '@/types/database';
import { formatChildAge } from '@/types/database';

/* ---- chip ↔ schema mappings (UI follows the design; storage is unchanged) ---- */
const WEEKDAYS: PreferredDay[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKENDS: PreferredDay[] = ['sat', 'sun'];
const TIME_CHIPS: [PreferredTime, string][] = [
  ['morning', '🌅 Morning'],
  ['afternoon', '☀️ Afternoon'],
  ['evening', '🌙 Evening'],
];
const BUDGET_CHIPS: [string, string, number | null, number | null][] = [
  ['u40', 'Under $40', 0, 40],
  ['40-80', '$40 – $80', 40, 80],
  ['80-120', '$80 – $120', 80, 120],
  ['120+', '$120+', 120, null],
];

function Stepper({ step }: { step: number }) {
  const items = ['Your details & preferences', 'Your child', 'See matches'];
  return (
    <div className="stepper">
      {items.map((label, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'active' : '';
        return (
          <div key={label} className={`s-step ${state}`}>
            {n < items.length && <span className="s-line" />}
            <span className="s-dot">{n < step ? <IconCheck size={15} /> : n}</span>
            <span className="s-label">{label}</span>
          </div>
        );
      })}
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
  const [weekdaysOn, setWeekdaysOn] = useState(false);
  const [weekendsOn, setWeekendsOn] = useState(false);
  const [times, setTimes] = useState<PreferredTime[]>([]);
  const [budgetKey, setBudgetKey] = useState<string | null>(null);
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
        setWeekdaysOn(WEEKDAYS.every((d) => prefs.preferred_days.includes(d)));
        setWeekendsOn(WEEKENDS.every((d) => prefs.preferred_days.includes(d)));
        setTimes(prefs.preferred_times);
        const match = BUDGET_CHIPS.find(
          ([, , min, max]) =>
            (prefs.budget_min ?? null) === min && (prefs.budget_max ?? null) === max
        );
        setBudgetKey(match?.[0] ?? null);
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
      /* best-effort */
    }

    const days: PreferredDay[] = [
      ...(weekdaysOn ? WEEKDAYS : []),
      ...(weekendsOn ? WEEKENDS : []),
    ];
    const budget = BUDGET_CHIPS.find(([k]) => k === budgetKey);

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
        budget_min: budget ? budget[2] : null,
        budget_max: budget ? budget[3] : null,
        interests,
      })
      .eq('user_id', user.id);

    setBusy(false);
    if (profileError || prefsError) {
      setError((profileError ?? prefsError)!.message);
      return;
    }
    setStep(2);
    window.scrollTo({ top: 0 });
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

  const categoryName = (slug: string) =>
    categories.find((c) => c.slug === slug)?.name ?? slug;
  const budgetLabel = BUDGET_CHIPS.find(([k]) => k === budgetKey)?.[1];
  const timeSummary = [
    weekdaysOn && 'Weekdays',
    weekendsOn && 'Weekends',
    ...times.map((t) => t[0].toUpperCase() + t.slice(1)),
  ]
    .filter(Boolean)
    .join(', ');

  const interestGrid = (selected: string[], onToggle: (slug: string) => void) => (
    <div className="int-grid">
      {categories.map((c) => {
        const meta = catMeta(c.slug);
        const on = selected.includes(c.slug);
        return (
          <div
            key={c.slug}
            className={`int-tile ${meta.soft}${on ? ' on' : ''}`}
            onClick={() => onToggle(c.slug)}
            role="checkbox"
            aria-checked={on}
          >
            {on && (
              <span className="int-check">
                <IconCheck size={12} />
              </span>
            )}
            <span className="ico">{meta.emoji}</span>
            {c.name}
          </div>
        );
      })}
    </div>
  );

  return (
    <main className="container">
      <div className="ob-shell">
        <Stepper step={step} />
        {error && <p className="notice error">{error}</p>}

        {/* ================= STEP 1 ================= */}
        {step === 1 && (
          <form onSubmit={saveStep1}>
            <p className="ob-eyebrow">Step 1 of 3</p>
            <h1 className="ob-h1">Let’s get to know you</h1>
            <p className="ob-sub">This helps us show options for your family.</p>

            <section className="ob-card">
              <div className="ob-card-head">
                <h3>
                  <IconUser size={17} /> Parent / Guardian details
                </h3>
              </div>
              <div className="field">
                <label className="f-label">Full name</label>
                <input placeholder="e.g. Sarah Tan" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
              </div>
              <div className="field">
                <label className="f-label">Email address</label>
                <input value={email} disabled title="Email comes from your account" />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="f-label">Phone number</label>
                <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr', gap: 10 }}>
                  <input value="🇸🇬 +65" disabled aria-label="Country code" />
                  <input placeholder="8123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
                </div>
              </div>
            </section>

            <section className="ob-card">
              <div className="ob-card-head">
                <h3>
                  <IconPin size={17} /> Where are you located?
                </h3>
              </div>
              <p className="hint" style={{ margin: '-6px 0 10px' }}>
                We’ll show activities near you.
              </p>
              <input
                placeholder="Enter your postcode or area"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                pattern="\d{6}"
                title="6-digit Singapore postal code"
                required
              />
            </section>

            <section className="ob-card">
              <div className="ob-card-head">
                <h3>
                  <IconHeart size={17} /> Your preferences
                </h3>
              </div>
              <p className="hint" style={{ margin: '-6px 0 14px' }}>
                Help us understand what you’re looking for.
              </p>

              <div className="pref-group">
                <span className="pref-label">
                  <IconCalendar size={15} /> Preferred time <span className="hint">· Select all that apply</span>
                </span>
                <div className="chip-row">
                  <span className={`chip clickable${weekdaysOn ? ' on' : ''}`} onClick={() => setWeekdaysOn(!weekdaysOn)}>
                    📅 Weekdays
                  </span>
                  <span className={`chip clickable${weekendsOn ? ' on' : ''}`} onClick={() => setWeekendsOn(!weekendsOn)}>
                    🎉 Weekends
                  </span>
                  {TIME_CHIPS.map(([value, label]) => (
                    <span
                      key={value}
                      className={`chip clickable${times.includes(value) ? ' on' : ''}`}
                      onClick={() => setTimes(toggle(times, value))}
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>

              <div className="pref-group">
                <span className="pref-label">
                  <IconDollar size={15} /> Budget per activity <span className="hint">· Select a range</span>
                </span>
                <div className="chip-row">
                  {BUDGET_CHIPS.map(([key, label]) => (
                    <span
                      key={key}
                      className={`chip clickable${budgetKey === key ? ' on' : ''}`}
                      onClick={() => setBudgetKey(budgetKey === key ? null : key)}
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>

              <div className="pref-group">
                <span className="pref-label">
                  <IconHeart size={15} /> What interests you? <span className="hint">· Select all that apply</span>
                </span>
                <div className="chip-row">
                  {categories.map((c) => (
                    <span
                      key={c.slug}
                      className={`chip clickable${interests.includes(c.slug) ? ' on' : ''}`}
                      onClick={() => setInterests(toggle(interests, c.slug))}
                    >
                      {catMeta(c.slug).emoji} {c.name}
                    </span>
                  ))}
                </div>
              </div>
            </section>

            <div className="privacy-note">
              <IconShield size={18} />
              <span>
                Your information stays private. We’ll never share your details.
              </span>
            </div>

            <button className="btn lg block" disabled={busy}>
              {busy ? 'Saving…' : 'Continue'} <IconArrowRight size={17} />
            </button>
          </form>
        )}

        {/* ================= STEP 2 ================= */}
        {step === 2 && (
          <div>
            <p className="ob-eyebrow">Step 2 of 3</p>
            <h1 className="ob-h1">
              Tell us about your <span className="hl">child</span>
            </h1>
            <p className="ob-sub">
              Add details to get activities that match their age, interests and stage.
            </p>

            {children.map((c, i) => (
              <section key={c.id} className="ob-card">
                <div className="ob-card-head">
                  <h3>
                    <span className="avatar">{initials(c.name)}</span> {c.name}
                  </h3>
                  <button
                    className="icon-btn"
                    style={{ color: '#c2375f' }}
                    onClick={() => removeChild(c.id)}
                    aria-label={`Remove ${c.name}`}
                  >
                    <IconTrash size={16} />
                  </button>
                </div>
                <p className="hint" style={{ margin: 0 }}>
                  Child {i + 1} · {formatChildAge(c.date_of_birth)}
                  {c.interests.length > 0 && <> · {c.interests.map(categoryName).join(', ')}</>}
                </p>
              </section>
            ))}

            <form onSubmit={addChild}>
              <section className="ob-card">
                <div className="ob-card-head">
                  <h3>
                    <IconUser size={17} /> Child {children.length + 1}
                  </h3>
                </div>
                <div className="field">
                  <label className="f-label">Child’s name</label>
                  <input placeholder="e.g. Emma" value={childName} onChange={(e) => setChildName(e.target.value)} required />
                </div>
                <div className="field">
                  <label className="f-label">Date of birth</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'stretch' }}>
                    <input
                      type="date"
                      max={new Date().toISOString().slice(0, 10)}
                      value={childDob}
                      onChange={(e) => setChildDob(e.target.value)}
                      required
                    />
                    <div className="card" style={{ padding: '8px 12px', background: 'var(--blue-soft)', border: 0, textAlign: 'center' }}>
                      <strong style={{ fontSize: 13, display: 'block' }}>
                        {childDob ? formatChildAge(childDob) : '🎂 Age'}
                      </strong>
                      <span className="hint" style={{ fontSize: 11 }}>Automatically calculated</span>
                    </div>
                  </div>
                </div>
                <div className="field">
                  <label className="f-label">Gender (optional)</label>
                  <div className="seg-row">
                    {([
                      ['male', '👦 Boy'],
                      ['female', '👧 Girl'],
                      ['unspecified', '🤝 Prefer not to say'],
                    ] as [Gender, string][]).map(([value, label]) => (
                      <span
                        key={value}
                        className={`seg${childGender === value ? ' on' : ''}`}
                        onClick={() => setChildGender(value)}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label className="f-label">
                    What is your child interested in? <span className="hint">Select all that apply.</span>
                  </label>
                  {interestGrid(childInterests, (slug) => setChildInterests(toggle(childInterests, slug)))}
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="f-label">Any other preferences or notes?</label>
                  <textarea
                    rows={3}
                    placeholder="e.g. Shy around new people, loves dancing…"
                    value={childNotes}
                    onChange={(e) => setChildNotes(e.target.value)}
                  />
                </div>
              </section>
              <button className="btn outline block" disabled={busy}>
                {busy ? 'Adding…' : `+ Add ${children.length > 0 ? 'another' : 'this'} child`}
              </button>
            </form>

            <div className="btn-row">
              <button className="btn outline" onClick={() => setStep(1)}>
                <IconArrowLeft size={16} /> Back
              </button>
              <button className="btn" disabled={children.length === 0} onClick={() => { setStep(3); window.scrollTo({ top: 0 }); }}>
                Continue <IconArrowRight size={16} />
              </button>
            </div>
            {children.length === 0 && (
              <p className="hint center" style={{ marginTop: 10 }}>
                Add at least one child to continue.
              </p>
            )}
          </div>
        )}

        {/* ================= STEP 3 ================= */}
        {step === 3 && (
          <div>
            <p className="ob-eyebrow">Step 3 of 3</p>
            <h1 className="ob-h1">Here’s a preview</h1>
            <p className="ob-sub">
              We’ve put together your details. Let’s find{' '}
              <span style={{ color: 'var(--blue)', fontWeight: 800 }}>matching activities</span>{' '}
              for your family.
            </p>

            <section className="ob-card">
              <div className="ob-card-head">
                <h3>
                  <IconUser size={17} /> Parent / Guardian
                </h3>
                <button className="edit-link" style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--blue)', font: 'inherit', fontWeight: 800 }} onClick={() => setStep(1)}>
                  Edit
                </button>
              </div>
              <div className="preview-row">
                <span className="avatar">{initials(fullName)}</span>
                <div>
                  <strong>{fullName}</strong>
                  <p className="hint" style={{ margin: '2px 0' }}>
                    {email}
                    {phone && <> · +65 {phone}</>}
                  </p>
                  {postalCode && (
                    <p className="hint" style={{ margin: 0 }}>
                      📍 Singapore ({postalCode})
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className="ob-card">
              <div className="ob-card-head">
                <h3>
                  <IconUser size={17} /> Your child{children.length > 1 ? 'ren' : ''}
                </h3>
                <button className="edit-link" style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--blue)', font: 'inherit', fontWeight: 800 }} onClick={() => setStep(2)}>
                  Edit
                </button>
              </div>
              {children.map((c) => (
                <div key={c.id} className="preview-row" style={{ marginBottom: 10 }}>
                  <span className="avatar" style={{ background: 'var(--pink-soft)', color: 'var(--pink)' }}>
                    {initials(c.name)}
                  </span>
                  <div>
                    <strong>{c.name}</strong>
                    <p className="hint" style={{ margin: '2px 0 0' }}>
                      {formatChildAge(c.date_of_birth)}
                      {c.gender !== 'unspecified' && <> · {c.gender === 'female' ? 'Girl' : c.gender === 'male' ? 'Boy' : c.gender}</>}
                    </p>
                    {c.interests.length > 0 && (
                      <p className="hint" style={{ margin: 0 }}>
                        Interests:{' '}
                        <span style={{ color: 'var(--blue)', fontWeight: 800 }}>
                          {c.interests.map(categoryName).join(', ')}
                        </span>
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </section>

            <section className="ob-card">
              <div className="ob-card-head">
                <h3>
                  <IconHeart size={17} /> Your preferences
                </h3>
                <button className="edit-link" style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--blue)', font: 'inherit', fontWeight: 800 }} onClick={() => setStep(1)}>
                  Edit
                </button>
              </div>
              <div className="next-info" style={{ textAlign: 'left' }}>
                <div>
                  <span className="pref-label"><IconCalendar size={15} /> Preferred time</span>
                  <p className="hint" style={{ margin: 0 }}>{timeSummary || 'Flexible'}</p>
                </div>
                <div>
                  <span className="pref-label"><IconDollar size={15} /> Budget per activity</span>
                  <p className="hint" style={{ margin: 0 }}>{budgetLabel ?? 'Flexible'}</p>
                </div>
                <div>
                  <span className="pref-label"><IconHeart size={15} /> Interests</span>
                  <p className="hint" style={{ margin: 0 }}>
                    {interests.length > 0 ? interests.map(categoryName).join(', ') : 'Open to anything'}
                  </p>
                </div>
              </div>
            </section>

            <section className="ob-card">
              <div className="next-info">
                <div>
                  <span className="ico"><IconSearch size={19} /></span>
                  <h4>Explore nearby</h4>
                  <p>Discover activities close to your location.</p>
                </div>
                <div>
                  <span className="ico"><IconHeart size={19} /></span>
                  <h4>Activities based on your preferences</h4>
                  <p>We’ll surface activities that match your selections.</p>
                </div>
                <div>
                  <span className="ico"><IconCalendar size={19} /></span>
                  <h4>Keep exploring</h4>
                  <p>You can update your preferences anytime.</p>
                </div>
              </div>
            </section>

            <div className="btn-row">
              <button className="btn outline" onClick={() => setStep(2)}>
                <IconArrowLeft size={16} /> Back
              </button>
              <button className="btn" disabled={busy} onClick={confirmProfile}>
                {busy ? 'Matching…' : 'Show me options'} <IconArrowRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
