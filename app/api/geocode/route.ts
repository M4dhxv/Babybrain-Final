import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { geocodePostalCode } from '@/lib/geocode';

/** Onboarding step 1: resolve a Singapore postal code to coordinates. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { postal_code: postalCode } = (await request.json()) as {
    postal_code?: string;
  };
  if (!postalCode || !/^\d{6}$/.test(postalCode.trim())) {
    return NextResponse.json({ error: 'Invalid postal code' }, { status: 400 });
  }

  const result = await geocodePostalCode(postalCode.trim());
  if (!result) {
    return NextResponse.json({ error: 'Postal code not found' }, { status: 404 });
  }
  return NextResponse.json(result);
}
