import Link from 'next/link';

/**
 * Branded catch-all for anything that reaches Next.js without a matching
 * route — e.g. a stray `/vendor/login` (the portal is a HashRouter SPA, its
 * real path is `/vendor/#/login`), a mistyped `/admin/…`, or an old link.
 * Without this file Next renders its own bare "404 | This page could not be
 * found" on a blank background; the root layout still wraps this with the
 * BabyBrain header and footer.
 */
export default function NotFound() {
  return (
    <main className="container" style={{ padding: '80px 0', textAlign: 'center' }}>
      <p style={{ fontSize: 'clamp(72px, 12vw, 128px)', fontWeight: 900, lineHeight: 1, color: 'var(--pink)', margin: 0 }}>
        404
      </p>
      <h1 style={{ fontSize: 'clamp(24px, 4vw, 34px)', fontWeight: 900, margin: '12px 0 8px' }}>
        This page doesn&rsquo;t exist
      </h1>
      <p style={{ color: 'var(--muted)', fontSize: 16, lineHeight: 1.6, maxWidth: '46ch', margin: '0 auto 28px' }}>
        The link may be broken or the page may have moved. Let&rsquo;s get you back on track.
      </p>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
        <Link href="/" className="btn lg">
          Back to home
        </Link>
        <Link href="/explore" className="btn outline lg">
          Explore activities
        </Link>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 28 }}>
        Running a business?{' '}
        <a href="/vendor/#/login" style={{ color: 'var(--blue)', fontWeight: 700 }}>
          Sign in to the vendor portal
        </a>
      </p>
    </main>
  );
}
