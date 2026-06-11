/** Visual metadata per activity category (colors + emoji per the design). */
export const CATEGORY_META: Record<
  string,
  { emoji: string; soft: string; solid: string; tagline: string }
> = {
  music: { emoji: '🎵', soft: 'soft-music', solid: 'cat-music', tagline: 'Make learning fun with rhythm & songs' },
  'sensory-play': { emoji: '✋', soft: 'soft-sensory-play', solid: 'cat-sensory-play', tagline: 'Explore, touch and discover' },
  'art-creativity': { emoji: '🎨', soft: 'soft-art-creativity', solid: 'cat-art-creativity', tagline: 'Inspire imagination through art' },
  movement: { emoji: '🏃', soft: 'soft-movement', solid: 'cat-movement', tagline: 'Active play for strong bodies' },
  'early-learning': { emoji: '🧩', soft: 'soft-early-learning', solid: 'cat-early-learning', tagline: 'Curiosity today, smarter tomorrow' },
  'parent-baby': { emoji: '🤱', soft: 'soft-parent-baby', solid: 'cat-parent-baby', tagline: 'Bond, play and grow together' },
};

export const catMeta = (slug?: string | null) =>
  CATEGORY_META[slug ?? ''] ?? {
    emoji: '⭐',
    soft: 'soft-movement',
    solid: 'cat-movement',
    tagline: '',
  };
