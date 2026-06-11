'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import type { AppNotification } from '@/types/database';

export default function NotificationsPage() {
  const supabase = createClient();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      setNotifications(data ?? []);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function markRead(id: string) {
    const readAt = new Date().toISOString();
    await supabase.from('notifications').update({ read_at: readAt }).eq('id', id);
    setNotifications((ns) =>
      ns.map((n) => (n.id === id ? { ...n, read_at: readAt } : n))
    );
  }

  async function markAllRead() {
    const readAt = new Date().toISOString();
    await supabase.from('notifications').update({ read_at: readAt }).is('read_at', null);
    setNotifications((ns) => ns.map((n) => ({ ...n, read_at: n.read_at ?? readAt })));
  }

  const unread = notifications.filter((n) => !n.read_at).length;

  return (
    <main className="container">
      <h1 style={{ fontSize: 40, marginTop: 20 }}>Notifications</h1>
      <p className="muted">
        <Link href="/dashboard">← Back to dashboard</Link>
        {unread > 0 && (
          <>
            {' '}·{' '}
            <button className="btn ghost small" onClick={markAllRead}>
              Mark all {unread} as read
            </button>
          </>
        )}
      </p>
      {loading && <p className="muted">Loading…</p>}
      {notifications.map((n) => {
        const url =
          n.data && typeof n.data === 'object' && 'url' in n.data
            ? String((n.data as { url: unknown }).url)
            : null;
        return (
          <div key={n.id} className="card" style={{ marginBottom: 10, opacity: n.read_at ? 0.7 : 1 }}>
            <h3 style={{ margin: '0 0 4px' }}>
              {!n.read_at && <span className="unread-dot" />}
              {n.title}
            </h3>
            {n.body && <p style={{ margin: '0 0 6px' }}>{n.body}</p>}
            <p className="muted" style={{ fontSize: 14, margin: 0 }}>
              {new Date(n.created_at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })}
              {url && (
                <>
                  {' '}· <Link href={url}>Open</Link>
                </>
              )}
              {!n.read_at && (
                <>
                  {' '}·{' '}
                  <button className="btn ghost small" onClick={() => markRead(n.id)}>
                    Mark read
                  </button>
                </>
              )}
            </p>
          </div>
        );
      })}
      {!loading && notifications.length === 0 && (
        <p className="notice">No notifications yet.</p>
      )}
    </main>
  );
}
