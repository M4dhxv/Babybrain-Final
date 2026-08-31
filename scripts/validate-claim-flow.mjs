/**
 * "Claim your business" end-to-end validation, against a running dev server.
 *
 *   npm run dev                            # in another terminal
 *   node scripts/validate-claim-flow.mjs
 *
 * QA 21/08: "once you enter the verification code it takes you to log in but no
 * password has been set — flow doesn't work." A claimer has no account and the
 * portal has no sign-up form, so the flow dead-ended. This proves the whole
 * path now completes for a brand-new vendor; that the account-creation step
 * can't be turned into a way to take over an existing login; and that when the
 * email DOES already have a login, signing in finishes the claim (rather than
 * stranding a half-done claim on the login page).
 *
 * Creates a throwaway provider and cleans it (and any account it made) up.
 */
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

process.loadEnvFile('.env.local');
const API = process.env.VALIDATE_API_BASE ?? 'http://localhost:3000';

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: 'require' });

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++; };

const stamp = Date.now();
/* Resend's simulated-delivery address, plus-addressed for a unique account per
   run. A made-up domain (…@babybrain-validation.test) would be accepted and
   then hard-bounce, and repeated hard bounces cost sending reputation — this
   claim flow really does send an email on every start. */
const claimEmail = `delivered+claim.${stamp}@resend.dev`;
const otherEmail = `delivered+exp.${stamp}@resend.dev`;
const PASSWORD = 'ClaimTest12345!';

const post = (path, body, token) =>
  fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ r, body: await r.json().catch(() => ({})) }));

/** The plaintext code never leaves the server, so re-hash a known one in place. */
async function setCode(claimId, code) {
  await sql`update provider_claims
            set email_code_hash = encode(digest(${code}, 'sha256'), 'hex')
            where id = ${claimId}`;
}

const { data: provider } = await admin
  .from('providers')
  .insert({ business_name: `Claim Test Co ${stamp}`, status: 'active', description: 'validation fixture' })
  .select()
  .single();

let createdUserIds = [];
try {
  // --- 1. Start a claim ---
  const start = await post('/api/vendor/claim/start', {
    provider_id: provider.id,
    email: claimEmail,
    uen: '201812345A',
  });
  check('Claim starts and a code is sent', start.r.ok && Boolean(start.body.claim_id), start.body.error ?? '');
  const claimId = start.body.claim_id;
  if (!claimId) throw new Error('no claim id');

  // --- 2. A wrong code is refused ---
  await setCode(claimId, '111111');
  const wrong = await post('/api/vendor/claim/verify', { claim_id: claimId, email_code: '222222' });
  check('A wrong code is rejected', wrong.r.status === 400, `HTTP ${wrong.r.status}`);

  // --- 3. The right code, with no password, asks for one (the old dead end) ---
  const noPass = await post('/api/vendor/claim/verify', { claim_id: claimId, email_code: '111111' });
  check('Correct code without a password asks for one', noPass.body.next === 'set_password', JSON.stringify(noPass.body.next));
  check('…and reports the email the account will use', noPass.body.email === claimEmail, noPass.body.email);
  check('…and has NOT handed over ownership yet', noPass.body.claimed === false, String(noPass.body.claimed));

  // --- 4. A too-short password is refused ---
  const shortPass = await post('/api/vendor/claim/verify', { claim_id: claimId, email_code: '111111', password: 'short' });
  check('A short password is rejected', shortPass.r.status === 400, `HTTP ${shortPass.r.status}`);

  // --- 5. The real thing: code + password completes the claim ---
  const done = await post('/api/vendor/claim/verify', { claim_id: claimId, email_code: '111111', password: PASSWORD });
  check('Code + password claims the business', done.body.claimed === true, done.body.error ?? JSON.stringify(done.body));
  check('…and reports that an account was created', done.body.account_created === true, String(done.body.account_created));

  const { data: userList } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const created = (userList?.users ?? []).find((u) => u.email === claimEmail);
  createdUserIds = created ? [created.id] : [];
  check('The account exists', Boolean(created), created?.id ?? 'not found');
  check('…already email-confirmed (the code proved the mailbox)', Boolean(created?.email_confirmed_at), String(created?.email_confirmed_at));

  // --- 6. The new login actually works, and owns the business ---
  const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({ email: claimEmail, password: PASSWORD });
  check('The vendor can sign in with the password they set', Boolean(signIn?.session), signInError?.message ?? '');

  const { data: member } = await admin
    .from('provider_members')
    .select('role, status')
    .eq('provider_id', provider.id)
    .eq('user_id', created?.id ?? '')
    .maybeSingle();
  check('They are an active owner of the provider', member?.role === 'owner' && member?.status === 'active', JSON.stringify(member));

  const { data: prov } = await admin
    .from('providers')
    .select('is_claimed, owner_id, verification_status')
    .eq('id', provider.id)
    .single();
  check('The provider is marked claimed and verified',
    prov.is_claimed === true && prov.owner_id === created?.id && prov.verification_status === 'verified',
    JSON.stringify(prov));

  // --- 7. An already-claimed business can't be claimed again ---
  const again = await post('/api/vendor/claim/start', { provider_id: provider.id, email: claimEmail });
  check('A claimed business refuses a new claim', again.r.status === 409, `HTTP ${again.r.status}`);

  // --- 8. An email that already has a login: the password step can't hijack
  //        it, and the real owner finishes the claim by signing in ---
  const { data: secondProvider } = await admin
    .from('providers')
    .insert({ business_name: `Claim Second Co ${stamp}`, status: 'active', description: 'validation fixture' })
    .select()
    .single();
  const second = await post('/api/vendor/claim/start', { provider_id: secondProvider.id, email: claimEmail });
  const secondClaim = second.body.claim_id;
  await setCode(secondClaim, '333333');
  const attempt = await post('/api/vendor/claim/verify', {
    claim_id: secondClaim, email_code: '333333', password: 'AttackerChosen999!',
  });
  check('An email that already has an account is told to sign in, not re-passworded',
    attempt.r.ok && attempt.body.next === 'sign_in', `HTTP ${attempt.r.status} ${JSON.stringify(attempt.body)}`);
  check('…ownership is NOT handed over on that response', attempt.body.claimed === false, String(attempt.body.claimed));
  const { data: stillWorks } = await anon.auth.signInWithPassword({ email: claimEmail, password: PASSWORD });
  check('…the original password still works', Boolean(stillWorks?.session));
  const { data: attackerTry } = await anon.auth.signInWithPassword({ email: claimEmail, password: 'AttackerChosen999!' });
  check('…and the attacker-chosen password does not', !attackerTry?.session);

  // Signed in, the same code (no password) completes the claim — this is the
  // "already-registered" dead end the page now walks the owner through.
  const finished = await post(
    '/api/vendor/claim/verify',
    { claim_id: secondClaim, email_code: '333333' },
    stillWorks?.session?.access_token
  );
  check('Signed in, the same code hands over ownership', finished.body.claimed === true,
    finished.body.error ?? JSON.stringify(finished.body));
  const { data: secondMember } = await admin
    .from('provider_members')
    .select('role, status')
    .eq('provider_id', secondProvider.id)
    .eq('user_id', created?.id ?? '')
    .maybeSingle();
  check('…and the owner now holds the second business too',
    secondMember?.role === 'owner' && secondMember?.status === 'active', JSON.stringify(secondMember));
  await admin.from('providers').delete().eq('id', secondProvider.id);

  // --- 9. An expired code is refused even with a password ---
  const { data: exp } = await admin
    .from('providers')
    .insert({ business_name: `Claim Expiry Co ${stamp}`, status: 'active', description: 'validation fixture' })
    .select()
    .single();
  const expStart = await post('/api/vendor/claim/start', { provider_id: exp.id, email: otherEmail });
  await setCode(expStart.body.claim_id, '444444');
  await sql`update provider_claims set expires_at = now() - interval '1 minute' where id = ${expStart.body.claim_id}`;
  const expired = await post('/api/vendor/claim/verify', {
    claim_id: expStart.body.claim_id, email_code: '444444', password: PASSWORD,
  });
  check('An expired code is refused', expired.r.status === 410, `HTTP ${expired.r.status}`);
  const { data: expProv } = await admin.from('providers').select('is_claimed').eq('id', exp.id).single();
  check('…and the business stays unclaimed', expProv.is_claimed === false, String(expProv.is_claimed));
  await admin.from('providers').delete().eq('id', exp.id);
} finally {
  await admin.from('providers').delete().eq('id', provider.id);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  await sql.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
