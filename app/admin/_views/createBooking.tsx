'use client';

import { useEffect, useState } from 'react';
import { Badge, C, adminFetch, input, primaryBtn, sgClock, sgDay, tabBtn, toast } from '../_lib/core';
import { Modal } from '../_lib/table';

// ---- Admin → Bookings → "Create booking" ----
// Book a customer into a class with a package credit, a make-up token, or by hand. Before anything is written
// the server cross-checks the credit / token against the class (see migration 00270) and the result is shown
// here as a checklist; the button stays off until every check passes. The server re-runs the same checks.

type Method = 'credit' | 'token' | 'manual';
type Parent = { id: string; name: string; email: string; phone: string | null };
type Cls = { id: string; title: string; vendorId: string; vendorName: string; startsAt: string; capacity: number | null; taken: number };
type Pack = { id: string; name: string; vendorId: string; vendorName: string; remaining: number; total: number; expiresAt: string | null };
type Tok = { id: string; vendorId: string; vendorName: string; childId: string | null; childName: string | null; expiresAt: string | null };
type Kid = { id: string; name: string };
type Check = { key: string; label: string; ok: boolean; detail: string };
type Verdict = { ok: boolean; checks: Check[]; class?: { title: string; vendor: string; vendor_id: string }; funding?: { kind: string; label: string; vendor: string; vendor_id: string; remaining: number; total: number } | null };

const METHODS: { id: Method; label: string; hint: string }[] = [
  { id: 'credit', label: 'Package credit', hint: 'Uses one credit from a pack the customer bought.' },
  { id: 'token', label: 'Make-up token', hint: 'Uses one of the customer\'s unused make-up tokens.' },
  { id: 'manual', label: 'Manual booking', hint: 'A phone or walk-in booking: no account, no credit used.' },
];

const exp = (iso: string | null) => (iso ? `expires ${sgDay(iso)}` : 'no expiry');

export default function CreateBookingModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [method, setMethod] = useState<Method>('credit');
  // customer
  const [pq, setPq] = useState('');
  const [parents, setParents] = useState<Parent[] | null>(null);
  const [parent, setParent] = useState<Parent | null>(null);
  const [kids, setKids] = useState<Kid[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [toks, setToks] = useState<Tok[]>([]);
  const [loadingParent, setLoadingParent] = useState(false);
  // class
  const [cq, setCq] = useState('');
  const [classes, setClasses] = useState<Cls[] | null>(null);
  const [cls, setCls] = useState<Cls | null>(null);
  // funding and details
  const [purchaseId, setPurchaseId] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [childId, setChildId] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestContact, setGuestContact] = useState('');
  const [paid, setPaid] = useState(false);
  const [allowOver, setAllowOver] = useState(false);
  const [reason, setReason] = useState('');
  // verification
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Customer search.
  useEffect(() => {
    const q = pq.trim();
    if (q.length < 2) { setParents(null); return; }
    let stale = false;
    const t = setTimeout(() => {
      adminFetch<{ parents: Parent[] }>(`/api/admin/bookings/new?q=${encodeURIComponent(q)}`)
        .then((r) => { if (!stale) setParents(r.parents); }).catch(() => { if (!stale) setParents([]); });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [pq]);

  // Class search.
  useEffect(() => {
    const q = cq.trim();
    if (q.length < 2) { setClasses(null); return; }
    let stale = false;
    const t = setTimeout(() => {
      adminFetch<{ classes: Cls[] }>(`/api/admin/bookings/new?class_q=${encodeURIComponent(q)}`)
        .then((r) => { if (!stale) setClasses(r.classes); }).catch(() => { if (!stale) setClasses([]); });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [cq]);

  function pickParent(p: Parent) {
    setParent(p); setParents(null); setPq('');
    setPurchaseId(''); setTokenId(''); setChildId('');
    if (method === 'manual') { setGuestName(p.name); setGuestContact(p.phone || p.email); }
    setLoadingParent(true);
    adminFetch<{ children: Kid[]; packs: Pack[]; tokens: Tok[] }>(`/api/admin/bookings/new?parent_id=${p.id}`)
      .then((r) => { setKids(r.children); setPacks(r.packs); setToks(r.tokens); if (r.children.length === 1) setChildId(r.children[0].id); })
      .catch((e) => toast(e instanceof Error ? e.message : String(e), 'error'))
      .finally(() => setLoadingParent(false));
  }

  function changeMethod(m: Method) {
    setMethod(m); setPurchaseId(''); setTokenId(''); setVerdict(null); setSaveErr(null); setAllowOver(false);
  }

  const chosenTok = toks.find((t) => t.id === tokenId) ?? null;
  const needsFunding = method !== 'manual';
  const ready = !!cls && (method === 'manual' ? !!guestName.trim()
    : !!parent && (method === 'credit' ? !!purchaseId : !!tokenId));
  const effectiveChild = method === 'token' ? (chosenTok?.childId ?? '') : childId;

  // Run the cross-checks whenever the choices change.
  useEffect(() => {
    if (!ready || !cls) { setVerdict(null); setVerifyErr(null); return; }
    let stale = false;
    setVerifying(true); setVerifyErr(null);
    const t = setTimeout(() => {
      adminFetch<Verdict>('/api/admin/bookings/new', {
        method: 'POST',
        body: JSON.stringify({
          action: 'verify', method, session_id: cls.id, parent_id: parent?.id, purchase_id: purchaseId || undefined,
          token_id: tokenId || undefined, child_id: effectiveChild || undefined, allow_over_capacity: allowOver,
        }),
      })
        .then((r) => { if (!stale) setVerdict(r); })
        .catch((e) => { if (!stale) { setVerdict(null); setVerifyErr(e instanceof Error ? e.message : String(e)); } })
        .finally(() => { if (!stale) setVerifying(false); });
    }, 200);
    return () => { stale = true; clearTimeout(t); };
  }, [ready, method, cls, parent, purchaseId, tokenId, effectiveChild, allowOver]);

  const canCreate = ready && !!verdict?.ok && !verifying && reason.trim().length >= 3 && !saving;

  async function create() {
    if (!cls) return;
    setSaving(true); setSaveErr(null);
    try {
      const r = await adminFetch<{ ok: true; status: string; credits_after?: number }>('/api/admin/bookings/new', {
        method: 'POST',
        body: JSON.stringify({
          action: 'create', method, session_id: cls.id, parent_id: parent?.id, purchase_id: purchaseId || undefined,
          token_id: tokenId || undefined, child_id: effectiveChild || undefined, guest_name: guestName, guest_contact: guestContact,
          paid, allow_over_capacity: allowOver, reason,
        }),
      });
      toast(method === 'credit' ? `Booked. ${r.credits_after ?? 0} credit${r.credits_after === 1 ? '' : 's'} left on the pack.` : method === 'token' ? 'Booked. Make-up token used.' : 'Manual booking added.');
      onCreated();
      onClose();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  const lab: React.CSSProperties = { display: 'grid', gap: 4, fontSize: 12, color: C.muted, fontWeight: 700 };
  const sec: React.CSSProperties = { fontWeight: 800, fontSize: 13, color: C.text, marginTop: 18, marginBottom: 8 };
  const pickBtn = (selected: boolean, disabled = false): React.CSSProperties => ({
    textAlign: 'left', width: '100%', padding: '9px 12px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer', font: 'inherit', color: C.text,
    border: `1px solid ${selected ? C.blue : C.border}`, background: selected ? 'rgba(74,144,255,.12)' : C.bg, opacity: disabled ? 0.55 : 1,
  });
  const sameVendor = (id: string) => !cls || cls.vendorId === id;

  return (
    <Modal title="Create booking" onClose={onClose} width={680}>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 4 }}>
        Book a customer into a class. Credits and tokens are checked against the class&apos;s vendor before anything is saved.
      </div>

      <div style={sec}>1. How is it booked?</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {METHODS.map((m) => <button key={m.id} type="button" style={tabBtn(method === m.id)} onClick={() => changeMethod(m.id)}>{m.label}</button>)}
      </div>
      <div style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>{METHODS.find((m) => m.id === method)?.hint}</div>

      <div style={sec}>2. {method === 'manual' ? 'Customer (optional lookup)' : 'Customer'}</div>
      {parent ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, ...pickBtn(true), cursor: 'default' }}>
          <span><b>{parent.name}</b> <span style={{ color: C.muted, fontSize: 12 }}>{parent.email}</span></span>
          <button type="button" style={{ ...tabBtn(false), padding: '3px 10px', fontSize: 12 }}
            onClick={() => { setParent(null); setKids([]); setPacks([]); setToks([]); setPurchaseId(''); setTokenId(''); setChildId(''); }}>Change</button>
        </div>
      ) : (
        <>
          <input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Search by name, email or phone…" style={input()} />
          {parents && (
            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              {parents.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No customer found.</div>}
              {parents.map((p) => (
                <button key={p.id} type="button" style={pickBtn(false)} onClick={() => pickParent(p)}>
                  <b>{p.name}</b> <span style={{ color: C.muted, fontSize: 12 }}>{p.email}{p.phone ? ` · ${p.phone}` : ''}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div style={sec}>3. Class</div>
      {cls ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, ...pickBtn(true), cursor: 'default' }}>
          <span><b>{cls.title}</b> <span style={{ color: C.muted, fontSize: 12 }}>{cls.vendorName} · {sgDay(cls.startsAt)} {sgClock(cls.startsAt)}</span></span>
          <button type="button" style={{ ...tabBtn(false), padding: '3px 10px', fontSize: 12 }} onClick={() => { setCls(null); setVerdict(null); }}>Change</button>
        </div>
      ) : (
        <>
          <input value={cq} onChange={(e) => setCq(e.target.value)} placeholder="Search upcoming classes by activity or vendor name…" style={input()} />
          {classes && (
            <div style={{ display: 'grid', gap: 6, marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
              {classes.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>No upcoming classes match.</div>}
              {classes.map((c) => (
                <button key={c.id} type="button" style={pickBtn(false)} onClick={() => { setCls(c); setClasses(null); setCq(''); }}>
                  <b>{c.title}</b> <span style={{ color: C.muted, fontSize: 12 }}>{c.vendorName} · {sgDay(c.startsAt)} {sgClock(c.startsAt)}
                    {c.capacity != null ? ` · ${c.taken}/${c.capacity} booked` : ''}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {needsFunding && (
        <>
          <div style={sec}>4. {method === 'credit' ? 'Which package credit?' : 'Which make-up token?'}</div>
          {!parent && <div style={{ color: C.muted, fontSize: 13 }}>Choose the customer first.</div>}
          {parent && loadingParent && <div style={{ color: C.muted, fontSize: 13 }}>Loading…</div>}
          {parent && !loadingParent && method === 'credit' && (
            <div style={{ display: 'grid', gap: 6 }}>
              {packs.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>This customer has no active package with credits left.</div>}
              {packs.map((p) => {
                const match = sameVendor(p.vendorId);
                return (
                  <button key={p.id} type="button" disabled={!match} style={pickBtn(purchaseId === p.id, !match)} onClick={() => setPurchaseId(p.id)}>
                    <b>{p.name}</b> · {p.vendorName} <span style={{ color: C.muted, fontSize: 12 }}>· {p.remaining} of {p.total} credits left · {exp(p.expiresAt)}</span>
                    {!match && <span style={{ marginLeft: 8 }}><Badge tone="pink">Different vendor</Badge></span>}
                  </button>
                );
              })}
            </div>
          )}
          {parent && !loadingParent && method === 'token' && (
            <div style={{ display: 'grid', gap: 6 }}>
              {toks.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>This customer has no unused make-up tokens.</div>}
              {toks.map((t) => {
                const match = sameVendor(t.vendorId);
                return (
                  <button key={t.id} type="button" disabled={!match} style={pickBtn(tokenId === t.id, !match)} onClick={() => setTokenId(t.id)}>
                    <b>Make-up token</b> · {t.vendorName} <span style={{ color: C.muted, fontSize: 12 }}>{t.childName ? `· for ${t.childName} ` : ''}· {exp(t.expiresAt)}</span>
                    {!match && <span style={{ marginLeft: 8 }}><Badge tone="pink">Different vendor</Badge></span>}
                  </button>
                );
              })}
            </div>
          )}
          {method === 'credit' && kids.length > 0 && (
            <label style={{ ...lab, marginTop: 10 }}>Child
              <select value={childId} onChange={(e) => setChildId(e.target.value)} style={input()}>
                <option value="">Choose a child…</option>
                {kids.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            </label>
          )}
          {!cls && parent && <div style={{ color: C.muted, fontSize: 12, marginTop: 8 }}>Pick the class first to see which credits are from the same vendor.</div>}
        </>
      )}

      {method === 'manual' && (
        <>
          <div style={sec}>4. Who is coming?</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            <label style={lab}>Name<input value={guestName} onChange={(e) => setGuestName(e.target.value)} style={input()} placeholder="Parent or child name" /></label>
            <label style={lab}>Contact (optional)<input value={guestContact} onChange={(e) => setGuestContact(e.target.value)} style={input()} placeholder="Phone or email" /></label>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 13 }}>
            <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Already paid (outside BabyBrain)
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontSize: 13 }}>
            <input type="checkbox" checked={allowOver} onChange={(e) => setAllowOver(e.target.checked)} /> Add even though the class is full (raises capacity by one)
          </label>
          <div style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>Like a vendor&apos;s manual booking: it shows on the vendor&apos;s roster but not in the customer&apos;s app.</div>
        </>
      )}

      {ready && (
        <>
          <div style={sec}>5. Safety check</div>
          <div style={{ border: `1px solid ${verdict ? (verdict.ok ? C.green : C.pink) : C.border}`, borderRadius: 12, padding: 12, background: C.bg }}>
            {needsFunding && verdict?.funding && verdict.class && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10, fontSize: 13 }}>
                <div><div style={{ color: C.muted, fontSize: 11, fontWeight: 700 }}>CLASS IS RUN BY</div><b>{verdict.class.vendor}</b></div>
                <div><div style={{ color: C.muted, fontSize: 11, fontWeight: 700 }}>{verdict.funding.kind === 'credit' ? 'CREDIT IS FROM' : 'TOKEN IS FROM'}</div>
                  <b style={{ color: verdict.funding.vendor_id === verdict.class.vendor_id ? C.green : C.pink }}>{verdict.funding.vendor}</b></div>
              </div>
            )}
            {verifying && !verdict && <div style={{ color: C.muted, fontSize: 13 }}>Checking…</div>}
            {verifyErr && <div style={{ color: C.pink, fontSize: 13 }}>{verifyErr}</div>}
            {verdict && (
              <div style={{ display: 'grid', gap: 6, opacity: verifying ? 0.6 : 1 }}>
                {verdict.checks.map((c) => (
                  <div key={c.key} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: 6, fontSize: 13 }}>
                    <span style={{ color: c.ok ? C.green : C.pink, fontWeight: 900 }}>{c.ok ? '✓' : '✕'}</span>
                    <span><b>{c.label}</b><span style={{ color: c.ok ? C.muted : C.pink }}> — {c.detail}</span></span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <label style={{ ...lab, marginTop: 14 }}>Reason (kept in the audit log)
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} style={{ ...input(), resize: 'vertical' }}
              placeholder="e.g. Parent called; her payment failed in the app and the vendor agreed to use her credit" />
          </label>
        </>
      )}

      {saveErr && <p style={{ color: C.pink, fontSize: 13, margin: '12px 0 0' }}>{saveErr}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button type="button" style={tabBtn(false)} onClick={onClose}>Cancel</button>
        <button type="button" style={{ ...primaryBtn(), opacity: canCreate ? 1 : 0.5, cursor: canCreate ? 'pointer' : 'not-allowed' }} disabled={!canCreate} onClick={create}>
          {saving ? 'Booking…' : method === 'credit' ? 'Book and use 1 credit' : method === 'token' ? 'Book and use the token' : 'Add manual booking'}
        </button>
      </div>
    </Modal>
  );
}
