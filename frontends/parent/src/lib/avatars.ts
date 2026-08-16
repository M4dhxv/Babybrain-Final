/** Avatar catalogue.
 *
 *  QA: "Can the avatars be different age/races of babies and toddlers for the
 *  children and male/female of different races for adults? Bit like the emoji's
 *  on WhatsApp?"
 *
 *  We used to draw cartoon animals, which said nothing about who the profile
 *  belonged to. These are the standard Unicode people emoji with the five
 *  Fitzpatrick skin-tone modifiers — the same set WhatsApp shows — so a family
 *  can pick something that actually looks like them. Every base character below
 *  takes a tone modifier directly (no ZWJ sequences), so `face + tone` is always
 *  a single valid grapheme.
 */

const SKIN_TONES = ["\u{1F3FB}", "\u{1F3FC}", "\u{1F3FD}", "\u{1F3FE}", "\u{1F3FF}"] as const;

/** Babies through to older children, so the picture can match the age. */
const CHILD_FACES = [
  { char: "\u{1F476}", label: "baby" }, // 👶
  { char: "\u{1F9D2}", label: "young child" }, // 🧒
  { char: "\u{1F467}", label: "girl" }, // 👧
  { char: "\u{1F466}", label: "boy" }, // 👦
] as const;

const ADULT_FACES = [
  { char: "\u{1F9D1}", label: "adult" }, // 🧑
  { char: "\u{1F469}", label: "woman" }, // 👩
  { char: "\u{1F468}", label: "man" }, // 👨
  { char: "\u{1F9D5}", label: "adult in headscarf" }, // 🧕
  { char: "\u{1F9D4}", label: "bearded adult" }, // 🧔
] as const;

const TONE_LABELS = ["light", "medium-light", "medium", "medium-dark", "dark"] as const;

export interface AvatarOption {
  /** Stored in `parent_profiles.avatar_seed` / `children.avatar_seed`. */
  seed: string;
  emoji: string;
  label: string;
}

function build(
  faces: readonly { char: string; label: string }[],
  kind: "child" | "parent"
): AvatarOption[] {
  const out: AvatarOption[] = [];
  for (const face of faces) {
    for (const [i, tone] of SKIN_TONES.entries()) {
      out.push({
        seed: `${kind}:${face.label.replace(/\s+/g, "-")}:${i + 1}`,
        emoji: `${face.char}${tone}`,
        label: `${face.label}, ${TONE_LABELS[i]} skin tone`,
      });
    }
  }
  return out;
}

export const CHILD_AVATARS = build(CHILD_FACES, "child");
export const PARENT_AVATARS = build(ADULT_FACES, "parent");

/** Pastel circle behind the emoji: the six brand palette colours exactly as
 *  supplied. They only ever sit under an emoji, never under text, so the
 *  full-strength shades are fine here. */
export const AVATAR_BACKGROUNDS = [
  "#FFC1D6", // pink
  "#A7D8F8", // blue
  "#C7B1E6", // purple
  "#A8E59A", // green
  "#FFB77A", // orange
  "#FFD77A", // yellow
];

/** Stable small hash so an unseeded profile still gets a consistent picture
 *  rather than changing on every render. */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** The faces a stated gender should default to, or the whole catalogue when
 *  it's unstated (or "prefer not to say"). Seeds are `kind:face-label:tone`,
 *  so the face is the middle segment. */
function genderPool(
  catalogue: AvatarOption[],
  kind: "child" | "parent",
  gender?: string | null
): AvatarOption[] {
  const face =
    gender === "female" ? (kind === "child" ? "girl" : "woman")
      : gender === "male" ? (kind === "child" ? "boy" : "man")
        : null;
  if (!face) return catalogue;
  const pool = catalogue.filter((o) => o.seed.split(":")[1] === face);
  return pool.length ? pool : catalogue;
}

/** Resolve a stored seed (or any string, e.g. a name) to a picture.
 *
 *  A seed from the picker maps to exactly that option; anything else falls back
 *  to a deterministic choice, so people who never opened the picker still get a
 *  stable avatar instead of a generic blank. */
export function resolveAvatar(
  seed: string | null | undefined,
  kind: "child" | "parent",
  gender?: string | null
): { emoji: string; background: string; label: string } {
  const catalogue = kind === "child" ? CHILD_AVATARS : PARENT_AVATARS;
  const key = (seed && seed.trim()) || "babybrain";
  const chosen = catalogue.find((o) => o.seed === key);
  // QA: "the avatar should automatically go to a little boy or little girl if
  // gender is selected". Only when they haven't picked one themselves — an
  // explicit choice from the picker always wins. Skin tone still varies, so
  // the default isn't the same face for every child.
  const pool = chosen ? catalogue : genderPool(catalogue, kind, gender);
  const option = chosen ?? pool[hash(`${kind}:${key}`) % pool.length];
  return {
    emoji: option.emoji,
    background: AVATAR_BACKGROUNDS[hash(key) % AVATAR_BACKGROUNDS.length],
    label: option.label,
  };
}
