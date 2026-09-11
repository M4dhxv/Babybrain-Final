/**
 * One-off: stamp vendor_terms_accepted_at + marketing_consent_at on a provider
 * so /save-listing shows both agreement boxes pre-ticked (the new claim flow
 * writes these itself; existing providers claimed before it have them NULL).
 *
 * Usage:  node scripts/_backfill-claim-consent.mjs <provider_id> [--no-marketing]
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const providerId = process.argv[2];
const withMarketing = !process.argv.includes('--no-marketing');
if (!providerId) {
  console.error('Pass a provider_id.');
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const now = new Date().toISOString();
const patch = { vendor_terms_accepted_at: now };
if (withMarketing) patch.marketing_consent_at = now;

const { data, error } = await supabase
  .from('providers')
  .update(patch)
  .eq('id', providerId)
  .select('id, business_name, vendor_terms_accepted_at, marketing_consent_at');

if (error) {
  console.error(error);
  process.exit(1);
}
console.log('Updated:', data);
