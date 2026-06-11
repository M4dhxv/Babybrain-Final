import Link from 'next/link';

export default function ActivityCard({
  slug,
  title,
  imageUrl,
  subtitle,
  footer,
}: {
  slug: string;
  title: string;
  imageUrl?: string | null;
  subtitle?: string;
  footer?: React.ReactNode;
}) {
  return (
    <Link href={`/activities/${slug}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="activity">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={
            imageUrl ||
            'https://images.unsplash.com/photo-1529333166437-7750a6dd5a70?q=80&w=900&auto=format&fit=crop'
          }
          alt={title}
        />
        <div className="content">
          <h3 style={{ margin: '0 0 6px', fontSize: 20 }}>{title}</h3>
          {subtitle && (
            <p className="muted" style={{ margin: 0, fontSize: 15 }}>
              {subtitle}
            </p>
          )}
          {footer}
        </div>
      </div>
    </Link>
  );
}
