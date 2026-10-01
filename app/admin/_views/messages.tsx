'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { C, Skeleton, adminFetch, card, input, primaryBtn, peekCache, toast } from '../_lib/core';

type Channel = {
  id: string; kind: string; name: string; members: string[]; memberCount: number;
  lastMessage: { text: string; at: string | null; userName: string } | null;
};
type Message = {
  id: string; text: string; at: string | null; userId: string; userName: string; isSupport: boolean;
};

export default function MessagesView() {
  const [channels, setChannels] = useState<Channel[] | null>(() => peekCache<{ channels: Channel[] }>('/api/admin/channels')?.channels ?? null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  // Tracks whichever channel is current *right now*, synchronously — `active`
  // state is a snapshot from whenever the closure that reads it was created,
  // so an in-flight fetch/send that reads `active` instead of this ref would
  // apply its result to a channel the admin has since clicked away from.
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    adminFetch<{ channels: Channel[] }>('/api/admin/channels').then((r) => setChannels(r.channels)).catch(() => setChannels([]));
  }, []);

  const openChannel = useCallback(async (ch: Channel) => {
    activeIdRef.current = ch.id;
    setActive(ch); setMessages([]); setLoadingMsgs(true);
    try {
      const r = await adminFetch<{ messages: Message[] }>(`/api/admin/messages?channelId=${encodeURIComponent(ch.id)}`);
      // The admin may have clicked a different channel while this was in
      // flight — a slower fetch for the channel clicked *first* landing
      // after a faster one for the channel clicked *second* used to show
      // the wrong thread under the current header.
      if (activeIdRef.current !== ch.id) return;
      setMessages(r.messages);
    } finally {
      if (activeIdRef.current === ch.id) setLoadingMsgs(false);
    }
  }, []);

  async function send() {
    if (!active || !reply.trim()) return;
    const channelId = active.id;
    setSending(true);
    try {
      const r = await adminFetch<{ message: Message }>('/api/admin/messages', {
        method: 'POST', body: JSON.stringify({ channelId, text: reply.trim() }),
      });
      // Same guard as openChannel: don't let a reply sent to channel A land
      // in whichever channel happens to be open when the response arrives —
      // append it only if the admin is still looking at the channel it was
      // actually sent to.
      if (activeIdRef.current === channelId) {
        setMessages((prev) => [...prev, r.message]);
        setReply('');
      }
      toast('Reply sent');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send the reply.', 'error');
    } finally { setSending(false); }
  }

  const filtered = (channels ?? []).filter((c) =>
    !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.kind.toLowerCase().includes(q.toLowerCase()));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, height: 'calc(100vh - 150px)' }}>
      {/* channel list */}
      <div style={{ ...card(), padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: 12, borderBottom: `1px solid ${C.border}` }}>
          <input placeholder="Search conversations…" value={q} onChange={(e) => setQ(e.target.value)} style={input()} />
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {channels === null && <div style={{ padding: 16 }}><Skeleton rows={6} height={40} /></div>}
          {channels?.length === 0 && <p style={{ color: C.muted, padding: 16 }}>No conversations yet.</p>}
          {filtered.map((ch) => (
            <button key={ch.id} onClick={() => openChannel(ch)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '12px 14px', background:
                active?.id === ch.id ? C.panel2 : 'transparent', border: 'none', borderBottom: `1px solid ${C.border}`,
                color: C.text, cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontWeight: 800, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.name}</span>
                <span style={{ fontSize: 10, color: C.blue, flexShrink: 0 }}>{ch.kind}</span>
              </div>
              <div style={{ color: C.muted, fontSize: 12, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ch.lastMessage ? `${ch.lastMessage.userName}: ${ch.lastMessage.text}` : `${ch.memberCount} members`}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* thread */}
      <div style={{ ...card(), padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!active ? (
          <div style={{ margin: 'auto', color: C.muted }}>Select a conversation.</div>
        ) : (
          <>
            <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontWeight: 900 }}>{active.name}</div>
              <div style={{ color: C.muted, fontSize: 12 }}>{active.kind} · {active.members.join(', ')}</div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {loadingMsgs && <Skeleton rows={4} height={36} />}
              {!loadingMsgs && messages.length === 0 && <p style={{ color: C.muted }}>No messages yet.</p>}
              {messages.map((msg) => (
                <div key={msg.id} style={{ alignSelf: msg.isSupport ? 'flex-end' : 'flex-start', maxWidth: '70%' }}>
                  <div style={{ fontSize: 11, color: msg.isSupport ? C.green : C.muted, marginBottom: 2 }}>
                    {msg.userName}{msg.at ? ` · ${new Date(msg.at).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
                  </div>
                  <div style={{ background: msg.isSupport ? C.blue : C.panel2, color: msg.isSupport ? '#fff' : C.text,
                    padding: '8px 12px', borderRadius: 12, fontSize: 14, wordBreak: 'break-word' }}>{msg.text}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, padding: 14, borderTop: `1px solid ${C.border}` }}>
              <input placeholder="Reply as BabyBrain Support…" value={reply} onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                style={{ ...input(), flex: 1 }} />
              <button onClick={send} disabled={sending || !reply.trim()} style={primaryBtn()}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

