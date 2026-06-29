/**
 * Phase 2 integration validation (no Stripe keys needed):
 *  - provider_invites auto-links to provider_members on signup (trigger)
 *  - booking-confirmed notification trigger fires
 *  - GetStream parent↔provider channel create + token (live Stream creds)
 * Run: node scripts/validate-vendor-integrations.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { StreamChat } from 'stream-chat';

process.loadEnvFile('.env.local');
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++; };
const stamp = Date.now();

// owner + provider
const ownerEmail = `inv.owner.${stamp}@babybrain-validation.test`;
const { data: ownerU } = await admin.auth.admin.createUser({ email: ownerEmail, password: 'X12345678!', email_confirm: true });
const { data: prov } = await admin.from('providers').insert({ owner_id: ownerU.user.id, business_name: 'Invite Test Co', status: 'active' }).select().single();

// --- pending invite then signup auto-links ---
const inviteeEmail = `invitee.${stamp}@babybrain-validation.test`;
await admin.from('provider_invites').insert({ provider_id: prov.id, email: inviteeEmail, role: 'staff' });
const { data: inviteeU } = await admin.auth.admin.createUser({ email: inviteeEmail, password: 'X12345678!', email_confirm: true });
await new Promise((r) => setTimeout(r, 800)); // let the signup trigger run
const { data: linked } = await admin.from('provider_members').select('role,status').eq('provider_id', prov.id).eq('user_id', inviteeU.user.id).maybeSingle();
check('Pending invite auto-links to membership on signup', linked?.role === 'staff' && linked?.status === 'active', JSON.stringify(linked));
const { data: inv } = await admin.from('provider_invites').select('accepted_at').eq('provider_id', prov.id).eq('email', inviteeEmail).single();
check('Invite marked accepted', !!inv?.accepted_at);

// --- booking-confirmed notification trigger ---
const { data: act } = await admin.from('activities').insert({ slug: `inv-act-${stamp}`, title: 'Confirm Test Class', category_id: 1, provider_id: prov.id, is_published: true }).select().single();
const { data: sess } = await admin.from('activity_sessions').insert({ activity_id: act.id, starts_at: new Date(Date.now() + 5 * 864e5).toISOString(), ends_at: new Date(Date.now() + 5 * 864e5 + 36e5).toISOString() }).select().single();
const parentEmail = `inv.parent.${stamp}@babybrain-validation.test`;
const { data: parentU } = await admin.auth.admin.createUser({ email: parentEmail, password: 'X12345678!', email_confirm: true });
const { data: bk } = await admin.from('bookings').insert({ user_id: parentU.user.id, session_id: sess.id }).select().single();
await admin.from('bookings').update({ status: 'confirmed' }).eq('id', bk.id);
await new Promise((r) => setTimeout(r, 800));
const { data: notifs } = await admin.from('notifications').select('type').eq('user_id', parentU.user.id).eq('type', 'booking_confirmed');
check('Booking-confirmed notification fired', (notifs ?? []).length >= 1);

// --- GetStream parent↔provider channel (live) ---
try {
  const stream = StreamChat.getInstance(process.env.NEXT_PUBLIC_STREAM_KEY, process.env.STREAM_SECRET);
  const channelId = `pp-${prov.id.slice(0, 8)}-${parentU.user.id.slice(0, 8)}`;
  await stream.upsertUsers([{ id: parentU.user.id, name: 'Parent' }, { id: ownerU.user.id, name: 'Invite Test Co' }]);
  const ch = stream.channel('messaging', channelId, { members: [parentU.user.id, ownerU.user.id], created_by_id: parentU.user.id });
  await ch.create();
  const token = stream.createToken(parentU.user.id);
  check('Stream parent↔provider channel + token', typeof token === 'string' && token.length > 20, channelId);
  await ch.delete();
  await stream.deleteUser(parentU.user.id, { hard_delete: true });
  await stream.deleteUser(ownerU.user.id, { hard_delete: true });
} catch (e) {
  check('Stream parent↔provider channel + token', false, e.message);
}

// cleanup
for (const id of [ownerU.user.id, inviteeU.user.id, parentU.user.id]) await admin.auth.admin.deleteUser(id);
await admin.from('providers').delete().eq('id', prov.id);
console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
