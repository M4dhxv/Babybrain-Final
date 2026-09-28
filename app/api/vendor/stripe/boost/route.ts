import { NextResponse } from 'next/server';

/**
 * Boost (paid featured placement for one activity) — switched off.
 *
 * Never sold: no vendor screen called this route and nothing was ever bought.
 * Dropped on 29 Sep; featured placement now comes with the Premium plan
 * (migration 00191). Any manager could still have called this directly and
 * paid, so it now refuses everything.
 *
 * The webhook's `kind === 'boost'` branch and activities.boosted_until are
 * left in place (harmless with no way to create a Boost checkout). This file
 * can be deleted outright.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Boost is no longer available. Featured placement is included in the Premium plan.' },
    { status: 410 }
  );
}
