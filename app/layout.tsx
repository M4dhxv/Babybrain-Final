import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { createClient } from '@/lib/supabase/server';

export const metadata: Metadata = {
  title: 'BabyBrain.sg',
  description:
    'Discover activities and play spaces that match your child’s age, interests and stage of growth.',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

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
            <Link href="/" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="brand" style={{ fontSize: 30 }}>
                <span>🧠</span>
                <span>BabyBrain.sg</span>
              </div>
            </Link>
            <nav className="links" style={{ fontSize: 17 }}>
              <Link href="/">Home</Link>
              <Link href="/explore">Explore Activities</Link>
              {user && <Link href="/matches">Matches</Link>}
              {user && <Link href="/dashboard">Dashboard</Link>}
              <Link href="/contact">Contact</Link>
              {user ? (
                <form action="/auth/signout" method="post" style={{ display: 'inline' }}>
                  <button className="btn ghost small" type="submit">
                    Sign out
                  </button>
                </form>
              ) : (
                <>
                  <Link href="/login">
                    <button className="btn ghost small">Log In</button>
                  </Link>
                  <Link href="/signup">
                    <button className="btn small">Sign Up</button>
                  </Link>
                </>
              )}
            </nav>
          </div>
        </header>
        {children}
        <footer className="footer">
          <div className="container">
            Helping parents discover and book activities that support their
            child’s learning and development. · BabyBrain.sg
          </div>
        </footer>
      </body>
    </html>
  );
}
