import { createClient } from '@supabase/supabase-js';
process.loadEnvFile('.env.local');
import { getProviderWixCredentials } from '../lib/wix/client';
import type { Database } from '../types/database';

const admin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);
const PROVIDER_ID = 'a64b081d-476c-4530-b342-1276ca5c2002';
const creds = await getProviderWixCredentials(admin, PROVIDER_ID);
if (!creds) throw new Error('no creds');

async function wix(path: string, body: unknown) {
  const res = await fetch(`https://www.wixapis.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds!.accessToken}`, 'wix-site-id': creds!.siteId },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(path, '->', res.status);
  console.log(text.slice(0, 2000));
  console.log('---');
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Attempt 1: minimal appointment service creation.
await wix('/bookings/v2/services', {
  service: {
    name: 'QA Test Appointment',
    type: 'APPOINTMENT',
    onlineBooking: { enabled: true },
    schedule: {
      availabilityConstraints: {
        sessionDurations: [60],
        timeBetweenSessions: 0,
      },
    },
    staffMemberIds: ['9510202c-26cc-4eb3-8739-b4c38c1f6ee3'],
    payment: { rateType: 'NO_FEE', options: { online: false, inPerson: true } },
  },
});
