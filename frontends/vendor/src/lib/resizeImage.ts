/**
 * Downscales a photo before upload. Phone photos are 3-5MB / 4000px+; parents
 * decode every carousel slide on a mid-range phone, which is what makes swiping
 * stutter. 1600px on the long edge is sharp on any screen the hero shows on.
 * Returns the original file when it's already small, isn't a raster we can
 * re-encode (gif/svg), or anything in the pipeline fails.
 */
const MAX_EDGE = 1600;
const SKIP_BELOW_BYTES = 300 * 1024;

export async function resizeImage(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= SKIP_BELOW_BYTES) { bitmap.close(); return file; }
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return file; }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' });
  } catch {
    return file;
  }
}
