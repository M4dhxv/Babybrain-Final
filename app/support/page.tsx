'use client';

import dynamic from 'next/dynamic';

const SupportChat = dynamic(() => import('@/components/SupportChat'), {
  ssr: false,
  loading: () => <p className="muted">Loading chat…</p>,
});

export default function SupportPage() {
  return (
    <main className="container">
      <h1 style={{ fontSize: 40, marginTop: 20 }}>Chat with BabyBrain Support</h1>
      <p className="lead" style={{ fontSize: 18 }}>
        Have a question, feedback, or need assistance? Our team is happy to help.
      </p>
      <SupportChat />
    </main>
  );
}
