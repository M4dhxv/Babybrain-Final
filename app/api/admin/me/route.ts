import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';

/** Who is signed in to the admin and what they may do. Open to every admin role. */
export async function GET(request: Request) {
  const auth = await requireAdmin(request, ['admin', 'support']);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ email: auth.user.email, role: auth.role });
}
