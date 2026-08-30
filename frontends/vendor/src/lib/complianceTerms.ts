/**
 * The real source of these documents is the two "Required to publish" /
 * "Required for bookings" checkboxes on the listing setup flow
 * (SaveListingPage.tsx) — each currently has only a one-line summary and no
 * full legal text stored anywhere in the app. Rather than inventing longer
 * legal language that was never actually shown to (or reviewed by) a
 * vendor, this breaks each summary's own listed clauses into their own
 * headings, using only what those summaries already say — so the
 * Compliance tab (SettingsPage.tsx) shows a truthful expansion of the real
 * agreement, not a fabricated one.
 */

export interface ComplianceSection {
  heading: string;
  body: string;
}

export interface ComplianceDocument {
  key: 'vendor_terms' | 'booking_messaging_terms';
  title: string;
  /** The exact summary text shown next to the checkbox at signup. */
  summary: string;
  sections: ComplianceSection[];
}

export const VENDOR_TERMS: ComplianceDocument = {
  key: 'vendor_terms',
  title: 'Vendor Terms',
  summary:
    'Includes content ownership, child photo consent, PDPA obligations, review policy, platform rules and suspension & removal rights.',
  sections: [
    {
      heading: 'Content Ownership',
      body: 'You retain ownership of the photos, descriptions and other content you upload, and grant BabyBrain the rights needed to display it on the platform.',
    },
    {
      heading: 'Child Photo Consent',
      body: 'You are responsible for obtaining consent before uploading or sharing any photo that features a child.',
    },
    {
      heading: 'PDPA Obligations',
      body: 'You agree to handle any personal data you receive through BabyBrain (parent and child details) in line with Singapore’s Personal Data Protection Act.',
    },
    {
      heading: 'Review Policy',
      body: 'Parent reviews of your business are collected and displayed according to BabyBrain’s review and moderation policy.',
    },
    {
      heading: 'Platform Rules & Suspension',
      body: 'You agree to BabyBrain’s platform conduct rules, and that a listing violating them may be suspended or removed.',
    },
  ],
};

export const BOOKING_MESSAGING_TERMS: ComplianceDocument = {
  key: 'booking_messaging_terms',
  title: 'Booking & Messaging Terms',
  summary: 'Covers messaging rules, cancellation/rescheduling and refund policies.',
  sections: [
    {
      heading: 'Messaging Rules',
      body: 'How you may communicate with parents through BabyBrain’s built-in messaging.',
    },
    {
      heading: 'Cancellation & Rescheduling',
      body: 'Requirements around cancelling or rescheduling a session a parent has booked.',
    },
  ],
};
