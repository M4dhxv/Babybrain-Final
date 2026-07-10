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
};

export const activities: Activity[] = [
  {
    title: "Baby Beats & Melodies",
    category: "Music",
    image: `${import.meta.env.BASE_URL}assets/crops/activity-music.png`,
    age: "6 - 24 months",
    venue: "MelodyHaus, Novena",
    date: "Mon, Wed",
    time: "11:00 AM",
    rating: "4.8 (90)",
    note: "Popular this week",
  },
  {
    title: "Sensory Explorers Playtime",
    category: "Sensory Play",
    image: `${import.meta.env.BASE_URL}assets/crops/activity-sensory.png`,
    age: "18 months - 4 years",
    venue: "Little Steps Playhouse, Katong",
    date: "Tue, Thu",
    time: "10:00 AM",
    rating: "4.8 (96)",
    note: "Frequently saved",
  },
  {
    title: "Little Artists Workshop",
    category: "Art",
    image: `${import.meta.env.BASE_URL}assets/crops/activity-art.png`,
    age: "2 - 6 years",
    venue: "Canvas Club, Tanjong Pagar",
    date: "Wed",
    time: "2:00 PM",
    rating: "4.8 (74)",
    note: "Trending nearby",
  },
  {
    title: "Mini Movers Adventure",
    category: "Movement",
    image: `${import.meta.env.BASE_URL}assets/crops/activity-movement.png`,
    age: "18 months - 5 years",
    venue: "Better Play, Katong",
    date: "Mon, Wed",
    time: "9:30 AM",
    rating: "4.9 (143)",
    note: "Frequently booked",
  },
  {
    title: "Play & Learn Together",
    category: "Early Learning",
    image: `${import.meta.env.BASE_URL}assets/crops/activity-play.png`,
    age: "12 months - 3 years",
    venue: "Tinkle House, Bukit Timah",
    date: "Tue, 28 May",
    time: "9:30 AM",
    rating: "4.7 (68)",
    note: "Trending nearby",
  },
];

// [icon, label, copy, slug] — slug is the activity_categories.slug the tile
// filters by on /explore (labels are marketing copy; slugs must match the DB).
export const categories = [
  ["music", "Music", "Make learning fun with rhythm & songs", "music"],
  ["hand", "Sensory Play", "Explore, touch and discover", "sensory-play"],
  ["palette", "Art & Creativity", "Inspire imagination through art", "art-creativity"],
  ["movement", "Movement & Dance", "Active play for strong bodies", "movement"],
  ["flask", "STEM & Learning", "Curiosity today, smarter tomorrow", "early-learning"],
  ["people", "Social & Emotional", "Build confidence and friendships", "parent-baby"],
];

export const routes = [
  { href: "/", label: "Home" },
  { href: "/explore", label: "Explore Activities" },
  { href: "/about", label: "About Us" },
  { href: "/contact", label: "Contact" },
];
