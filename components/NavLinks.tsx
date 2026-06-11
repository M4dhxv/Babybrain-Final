'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function NavLinks({ authed }: { authed: boolean }) {
  const pathname = usePathname();
  const links: [string, string][] = authed
    ? [
        ['/', 'Home'],
        ['/explore', 'Explore Activities'],
        ['/matches', 'Matches'],
        ['/dashboard', 'Dashboard'],
        ['/contact', 'Contact'],
      ]
    : [
        ['/', 'Home'],
        ['/explore', 'Explore Activities'],
        ['/contact', 'Contact'],
      ];

  return (
    <nav className="nav-links">
      {links.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          className={
            href === '/' ? (pathname === '/' ? 'active' : '') : pathname.startsWith(href) ? 'active' : ''
          }
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
