import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Upload one image from /admin and hand back its public URL.
 *
 * Goes into the same public `activity-images` bucket the vendor portal uses for
 * logos, so admin-uploaded and vendor-uploaded images live together. The write
 * uses the service role behind {@link requireAdmin} rather than the caller's
 * own token, so it doesn't depend on storage RLS being open to admins.
 *
 * The response is just a URL — the forms store URLs either way, so uploading
 * and pasting a link end up in exactly the same place.
 */
export const maxDuration = 60;

const MAX_BYTES = 6 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml'];

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected a file upload.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file was sent.' }, { status: 400 });
  if (!ALLOWED.includes(file.type)) {
    return NextResponse.json(
      { error: `${file.type || 'That file type'} isn't an image we can use — try JPEG, PNG, WebP or GIF.` },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `That image is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is 6MB.` },
      { status: 400 }
    );
  }

  // Folder keeps a vendor's uploads together; the timestamp stops one upload
  // silently replacing another with the same filename.
  const folder = String(form.get('folder') ?? 'admin').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64) || 'admin';
  const safeName = file.name.replace(/[^a-zA-Z0-9.-]+/g, '_').slice(-80);
  const path = `${folder}/${Date.now()}-${safeName}`;

  const db = createAdminClient();
  const { error } = await db.storage
    .from('activity-images')
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) return NextResponse.json({ error: `Upload failed: ${error.message}` }, { status: 500 });

  const { data } = db.storage.from('activity-images').getPublicUrl(path);
  return NextResponse.json({ url: data.publicUrl, path, bytes: file.size });
}
