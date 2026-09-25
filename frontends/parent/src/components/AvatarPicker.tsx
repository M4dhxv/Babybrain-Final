import { AnimalAvatar } from "./ui";
import type { AvatarOption } from "../lib/avatars";

/** Grid of avatar choices. Storing the chosen option's seed is all we need to
 *  reproduce the picture; `null` means "pick one for me from my name". Shared
 *  by ProfilePage's child form and EditProfilePage — kept here rather than in
 *  either page so splitting them into separate lazy chunks doesn't duplicate
 *  or diverge it. */
export function AvatarPicker({
  options,
  value,
  onChange,
  kind,
  fallbackSeed,
  gender,
}: {
  options: AvatarOption[];
  value: string | null;
  onChange: (seed: string | null) => void;
  kind: "child" | "parent";
  fallbackSeed?: string;
  /** Drives the "Choose for me" swatch, so it previews the girl/boy default. */
  gender?: string | null;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {[null, ...options.map((o) => o.seed)].map((seed) => {
        const on = value === seed;
        const label = seed ? options.find((o) => o.seed === seed)?.label ?? seed : "Choose for me";
        return (
          <button
            key={seed ?? "default"}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={on}
            onClick={() => onChange(seed)}
            className={`rounded-full p-0.5 transition ${on ? "ring-2 ring-baby-pink" : "ring-1 ring-[#F4EFF0] hover:ring-[#FFC1D6]"}`}
          >
            <AnimalAvatar seed={seed ?? fallbackSeed} kind={kind} gender={seed ? null : gender} className="h-11 w-11" />
          </button>
        );
      })}
    </div>
  );
}
