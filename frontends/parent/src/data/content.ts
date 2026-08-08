export type Activity = {
  title: string;
  category: string;
  image: string;
  age: string;
  venue: string;
  date: string;
  time: string;
  rating: string;
  note: string;
  slug?: string;
  id?: string;
  boosted?: boolean;
  providerName?: string;
  /** Shown on the card so parents don't have to open a listing to see these. */
  price?: number | null;
  durationMins?: number | null;
  region?: string | null;
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
  ["shoe", "Gym & Dance", "Tumbling, balance and moving", "movement"],
  ["movement", "Swimming", "Water confidence and lessons", "swimming"],
  ["flask", "Early Learning", "Curiosity today, ready for more", "early-learning"],
  ["people", "Parent & Child Exercise", "Move and bond together", "parent-baby"],
  ["home", "Playspaces", "Open, come-anytime play", "playspaces"],
  ["calendar", "Community Events", "Family days and meet-ups", "community-events"],
  ["spark", "Holiday Camps", "School-break adventures", "holiday-camps"],
];

// Nav + footer labels are Title Case; page headings and CTAs are sentence case.
export const routes = [
  { href: "/", label: "Home" },
  { href: "/explore", label: "Explore Activities" },
  { href: "/about", label: "About Us" },
  { href: "/contact", label: "Contact Us" },
];
