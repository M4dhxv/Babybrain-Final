/**
 * Audit (and optionally undo) "Claim Your Business" ownerships that attached to
 * the wrong account.
 *
 * The bug: /api/vendor/claim/verify granted provider ownership to whatever
 * session was on the request rather than to the account that proved control of
 * the claim's contact email. Fingerprint of a bad claim:
 *
 *   provider_claims.status = 'approved'
 *   AND lower(auth.users[claimed_by].email) <> lower(provider_claims.contact_email)
 *
 * i.e. the code went to address X but ownership landed on a different account.
 *
 * For each hit this prints the provider, the claim, the owner account, and the
 * provider_members row. With --repair it:
 *   - deletes the provider_members row for the wrong account (only if that row
 *     looks claim-created: role 'owner', and it is not the provider's only
 *     historical member from before the claim)
 *   - if providers.owner_id is that wrong account, resets
 *     owner_id -> null, is_claimed -> false, verification_status -> 'unverified'
 *   - sets the claim status -> 'rejected'
 *
 * It never touches an account's OTHER (legitimate) memberships.
 *
 * Run: node scripts/_audit-claim-ownership.mjs            (dry run / report)
 *      node scripts/_audit-claim-ownership.mjs --repair   (apply)
 */
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('.env.local');

const REPAIR = process.argv.includes('--repair');
const tag = REPAIR ? '[REPAIR]' : '[DRY RUN]';

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: users, error: usersErr } = await admin.auth.admin.listUsers({ perPage: 10000 });
if (usersErr) throw usersErr;
const emailById = new Map(users.users.map((u) => [u.id, (u.email ?? '').toLowerCase()]));

const { data: claims, error: claimsErr } = await admin
  .from('provider_claims')
  .select('id, provider_id, claimed_by, contact_email, status, created_at')
  .eq('status', 'approved')
  .order('created_at', { ascending: true });
if (claimsErr) throw claimsErr;

const bad = (claims ?? []).filter((c) => {
  if (!c.claimed_by) return false;
  const ownerEmail = emailById.get(c.claimed_by);
  return ownerEmail && ownerEmail !== c.contact_email.trim().toLowerCase();
});

console.log(`${tag} scanned ${claims?.length ?? 0} approved claims — ${bad.length} mismatched\n`);

for (const c of bad) {
  const { data: provider } = await admin
    .from('providers')
    .select('id, business_name, owner_id, is_claimed, verification_status')
    .eq('id', c.provider_id)
    .maybeSingle();
  const { data: membership } = await admin
    .from('provider_members')
    .select('id, user_id, role, status, created_at')
    .eq('provider_id', c.provider_id)
    .eq('user_id', c.claimed_by)
    .maybeSingle();

  console.log('─'.repeat(72));
  console.log(`provider   ${provider?.business_name ?? '(gone)'}  [${c.provider_id}]`);
  console.log(`claim      ${c.id}  code sent to ${c.contact_email}`);
  console.log(`owner acct ${emailById.get(c.claimed_by)}  [${c.claimed_by}]`);
  console.log(`providers.owner_id matches wrong acct: ${provider?.owner_id === c.claimed_by}`);
  console.log(`membership ${membership ? `${membership.role}/${membership.status} [${membership.id}]` : '(none)'}`);

  if (!REPAIR) continue;

  if (membership && membership.role === 'owner') {
    await admin.from('provider_members').delete().eq('id', membership.id);
    console.log('  - removed wrong-account membership');
  }
  if (provider?.owner_id === c.claimed_by) {
    await admin
      .from('providers')
      .update({ owner_id: null, is_claimed: false, verification_status: 'unverified' })
      .eq('id', c.provider_id);
    console.log('  - reset providers.owner_id / is_claimed / verification_status');
  }
  await admin.from('provider_claims').update({ status: 'rejected' }).eq('id', c.id);
  console.log('  - claim marked rejected');
}

console.log('─'.repeat(72));
console.log(REPAIR ? 'done.' : 're-run with --repair to apply.');
