export type Activity = {
  title: string;
  category: string;
  /** Optional second category (an activity can carry up to two). */
  category2?: string;
  image: string;
  age: string;
  venue: string;
  date: string;
  time: string;
  rating: string;
  slug?: string;
  id?: string;
  boosted?: boolean;
  providerName?: string;
  /** Shown on the card so parents don't have to open a listing to see these. */
  price?: number | null;
  durationMins?: number | null;
  region?: string | null;
  /** A private session at the customer's own home rather than a fixed venue —
   *  shown as `customLocationLabel` (or "Custom" if unset) / "as defined by
   *  you" instead of `region`. */
  isCustomLocation?: boolean;
  customLocationLabel?: string | null;
  /** Bookable on BabyBrain rather than the provider's own site. */
  instantBook?: boolean;
};

// [icon, label, copy, slug] — slug is the activity_categories.slug the tile
// filters by on /explore (labels are marketing copy; slugs must match the DB).
// Slugs stay as they are even where the label merged two old categories, since
// they're stored on child/preference records and linked from /explore?cat=.
export const categories = [
  ["music", "Music & Drama", "Rhythm, songs and performing", "music"],
  ["palette", "Sensory & Art", "Explore, touch and create", "sensory-play"],
  ["shoe", "Gym, Dance & Other Sports", "Tumbling, balance and moving", "movement"],
  ["movement", "Swimming", "Water confidence and lessons", "swimming"],
  ["flask", "Early Learning", "Curiosity today, ready for more", "early-learning"],
  ["people", "Parent & Child Exercise", "Move and bond together", "parent-baby"],
  ["home", "Playspaces", "Open, come-anytime play", "playspaces"],
  ["calendar", "Community Events", "Family days and meet-ups", "community-events"],
  ["spark", "Holiday Camps", "School-break adventures", "holiday-camps"],
];

// Age bands, as brackets rather than a single "child is N months old" probe.
// The old filter matched any class whose range *contained* the age, so picking
// "0 – 6 months" surfaced classes running up to 2 years. A band matches only
// when the class's own age range overlaps it. Shared by HomePage (age tiles)
// and ExplorePage (the Age filter) — kept here rather than in either page so
// splitting them into separate lazy chunks doesn't duplicate or diverge it.
export const AGE_BANDS: { key: string; label: string; min: number; max: number }[] = [
  { key: "0-5", label: "0 – 5 months", min: 0, max: 5 },
  { key: "6-11", label: "6 – 11 months", min: 6, max: 11 },
  { key: "12-17", label: "12 – 17 months", min: 12, max: 17 },
  { key: "18-35", label: "18 months – 3 years", min: 18, max: 35 },
  { key: "36+", label: "Over 3 years", min: 36, max: 132 },
];

// Nav + footer labels are Title Case; page headings and CTAs are sentence case.
export const routes = [
  { href: "/", label: "Home" },
  { href: "/explore", label: "Explore Activities" },
  { href: "/about", label: "About Us" },
  { href: "/contact", label: "Contact Us" },
];
