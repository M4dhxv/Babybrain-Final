import { NextResponse } from 'next/server';

/**
 * Retired (make-up credit, migration 00276). A make-up token used to be one booking, redeemed here for a
 * Wix-linked slot. Tokens are now a money balance with the vendor, spent through the normal checkout
 * (/api/wix/bookings/checkout with useCredit), where the card pays whatever the balance does not cover.
 *
 * Kept as a clear answer for a page that was opened before the change, instead of a 404.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'Make-up tokens now work from your balance. Please reload the page and book again.' },
    { status: 410 }
  );
}
