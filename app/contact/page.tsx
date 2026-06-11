import Link from 'next/link';

export default function ContactPage() {
  return (
    <main className="container">
      <section className="hero">
        <div>
          <p className="badge">We’re here to help</p>
          <h1 style={{ fontSize: 48 }}>How can our team support you today?</h1>
          <p className="lead" style={{ fontSize: 20 }}>
            Have a question, feedback, or need assistance? Our team is happy to help.
          </p>
        </div>
        <div className="hero-art" style={{ minHeight: 300 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://images.unsplash.com/photo-1598257006626-5f8976c2b08f?q=80&w=1200&auto=format&fit=crop"
            alt="Support"
          />
        </div>
      </section>

      <h2 className="section-title" style={{ fontSize: 32 }}>Get in touch</h2>
      <div className="grid4">
        <div className="card">
          <h3>Live support chat</h3>
          <p className="muted">Fastest way to reach us.</p>
          <Link href="/support">
            <button className="btn" style={{ width: '100%' }}>Start Chat</button>
          </Link>
        </div>
        <div className="card">
          <h3>Email us</h3>
          <p className="muted">hello@babybrain.sg</p>
          <a href="mailto:hello@babybrain.sg">
            <button className="btn ghost" style={{ width: '100%' }}>Send Email</button>
          </a>
        </div>
        <div className="card">
          <h3>Call us</h3>
          <p className="muted">Mon–Fri, 9am–6pm</p>
          <button className="btn ghost" style={{ width: '100%' }}>+65 9123 4567</button>
        </div>
        <div className="card">
          <h3>WhatsApp us</h3>
          <p className="muted">Quick questions welcome.</p>
          <button className="btn ghost" style={{ width: '100%' }}>Chat on WhatsApp</button>
        </div>
      </div>

      <h2 className="section-title" style={{ fontSize: 32 }}>Frequently asked questions</h2>
      <div className="card" style={{ marginBottom: 10 }}>
        How does BabyBrain recommend classes for my child?
      </div>
      <div className="card" style={{ marginBottom: 10 }}>How do I book a class?</div>
      <div className="card" style={{ marginBottom: 10 }}>
        Can I cancel or reschedule a booking?
      </div>
    </main>
  );
}
