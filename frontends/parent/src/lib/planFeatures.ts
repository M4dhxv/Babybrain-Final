/** The Free/Plus tier spec — the single source both PricingPage and the
 *  sign-up flow's plan step describe, so they can't drift the way they used
 *  to (each hardcoding its own copy of these bullets, kept "in step" only by
 *  a comment — they'd already diverged on 5 of 11 lines, wording only, but
 *  worth eliminating rather than re-syncing by hand a second time).
 *
 *  These lists have to describe what the app actually gates. Previously Free
 *  advertised "See messages from parents and class providers on booked
 *  classes" while ChatButton is gated on isPlus — i.e. it promised Free
 *  users something they could not do. Messaging is stated as Plus here,
 *  matching the code.
 *
 *  The saved family profile and preference-based suggestions are Free: the
 *  children tab and the recommendations that feed Matches are ungated. What
 *  is Plus is everything behind a plusOnly tab or an isPlus check —
 *  favourites, packages, make-up tokens, calendar export and messaging. */
export const FREE_PLAN_ITEMS = [
  "Browse & book activities",
  "Leave reviews",
  "Saved family profile",
  "Suggestions provided based on your preferences",
];

export const PLUS_PLAN_ITEMS = [
  "Everything in Free",
  "Twice weekly e-mails with available activities curated for your little ones",
  "Packages & make-up tokens for all vendors stored in one place",
  "Save favourite providers",
  "Export & share booked activities in calendar view",
  "For integrated activity providers, message them & other parents booked on the same activity",
  "Priority support",
];
