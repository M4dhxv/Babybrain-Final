import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import { createClient } from '@/lib/supabase/server';
import NavLinks from '@/components/NavLinks';
import { IconUser } from '@/components/icons';
import { initials } from '@/lib/format';

export const metadata: Metadata = {
  title: 'BabyBrain.sg — Curated activities that fit your child',
  description:
    'Discover activities and play spaces that match your child’s age, interests and stage of growth.',
  // Favicon only. The installable site at `/` is the parent SPA (see the
  // beforeFiles rewrite in next.config.mjs), so it carries the web app
  // manifest; a manifest route here would be shadowed by that rewrite and
  // never reached. These pages — /admin, /auth — just need a real icon.
  icons: {
    icon: [
      { url: '/assets/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/assets/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/assets/brand/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: { capable: true, title: 'BabyBrain', statusBarStyle: 'default' },
};

// Next 15 wants themeColor on the viewport export, not metadata.
export const viewport: Viewport = {
  themeColor: '#FA4D8D',
};

const BRAND_COLORS = ['#f59f0a', '#ef5a9a', '#2b6fe3', '#27a45f', '#8a6de9', '#ef5a9a', '#2b6fe3', '#f59f0a', '#27a45f'];

function Brand() {
  return (
    <Link href="/" className="brand" aria-label="BabyBrain.sg home">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/assets/mascot-face.png" alt="" />
      <span>
        {'BabyBrain'.split('').map((ch, i) => (
          <span key={i} style={{ color: BRAND_COLORS[i] }}>
            {ch}
          </span>
        ))}
        <span className="sg">.sg</span>
      </span>
    </Link>
  );
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let displayName: string | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from('parent_profiles')
      .select('full_name')
      .eq('id', user.id)
      .single();
    displayName = profile?.full_name || user.email || null;
  }

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <header className="nav">
          <div className="container nav-inner">
            <Brand />
            <NavLinks authed={Boolean(user)} />
            <div className="nav-auth">
              {user ? (
                <>
                  <Link href="/dashboard" className="avatar-chip">
                    <span className="avatar">{initials(displayName)}</span>
                    <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {displayName?.split(' ')[0] ?? 'You'}
                    </span>
                  </Link>
                  <form action="/auth/signout" method="post">
                    <button className="btn outline sm" type="submit">
                      Sign out
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <Link href="/login" className="btn outline sm">
                    <IconUser size={15} /> Log In
                  </Link>
                  <Link href="/signup" className="btn sm">
                    <IconUser size={15} /> Sign Up
                  </Link>
                </>
              )}
            </div>
          </div>
        </header>
        {children}
        <footer className="footer">
          <div className="container">
            <div className="footer-grid">
              <div>
                <Brand />
                <p>
                  Helping parents discover and book activities that support
                  their child’s growth, curiosity and joy.
                </p>
              </div>
              <div>
                <h4>Explore</h4>
                <Link href="/explore">Explore Activities</Link>
                <Link href="/explore">Categories</Link>
                <Link href="/explore">Play Spaces</Link>
              </div>
              <div>
                <h4>For Parents</h4>
                <Link href="/signup">Create Profile</Link>
                <Link href="/#how">How It Works</Link>
                <Link href="/contact">Tips &amp; Guides</Link>
              </div>
              <div>
                <h4>Support</h4>
                <Link href="/contact">Contact Us</Link>
                <Link href="/contact">FAQ</Link>
                <a href="mailto:hello@babybrain.sg">hello@babybrain.sg</a>
              </div>
            </div>
            <div className="copyright">
              © {new Date().getFullYear()} BabyBrain.sg. All rights reserved.
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
