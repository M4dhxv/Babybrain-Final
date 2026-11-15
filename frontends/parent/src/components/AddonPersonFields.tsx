import { ageWarning, hasAgeRange, parseAge, rangeText, type AgedOffer } from "../lib/addonAges";

/**
 * One row per extra person on an add-on: an optional name and an age. When the vendor gave the add-on
 * an age range the age is required, and an age outside it shows a warning (never a block).
 * Used on the booking page and in "Add a person" so both behave the same.
 */
export function AddonPersonFields({
  offer,
  offers,
  qty,
  names,
  ages,
  onName,
  onAge,
}: {
  offer: AgedOffer;
  offers: AgedOffer[];
  qty: number;
  names: string[] | undefined;
  ages: string[] | undefined;
  onName: (i: number, v: string) => void;
  onAge: (i: number, v: string) => void;
}) {
  const needsAge = hasAgeRange(offer);
  const range = rangeText(offer);
  return (
    <div className="mt-3 space-y-3">
      {range && <p className="text-xs font-bold text-[#59658d]">{offer.name} is for {range}. Enter each person&rsquo;s age.</p>}
      {Array.from({ length: qty }).map((_, i) => {
        const age = parseAge(ages?.[i]);
        const typed = (ages?.[i] ?? "").trim();
        const warning = ageWarning(offer, age, offers);
        const bad = typed !== "" && age === null;
        return (
          <div key={i}>
            <div className="flex gap-2">
              <input
                value={names?.[i] ?? ""}
                maxLength={80}
                autoComplete="off"
                autoCapitalize="words"
                onChange={(e) => onName(i, e.target.value)}
                placeholder={`${offer.name} name (optional)`}
                aria-label={`${offer.name} ${i + 1} name`}
                className="min-w-0 flex-1 rounded-[10px] border border-[#FED7E4] px-3 py-2 text-sm font-semibold"
              />
              <input
                value={ages?.[i] ?? ""}
                inputMode="numeric"
                maxLength={3}
                autoComplete="off"
                onChange={(e) => onAge(i, e.target.value.replace(/\D/g, ""))}
                placeholder={needsAge ? "Age" : "Age (optional)"}
                aria-label={`${offer.name} ${i + 1} age in years`}
                aria-invalid={warning != null || bad}
                className={`w-24 shrink-0 rounded-[10px] border px-3 py-2 text-sm font-semibold ${warning || bad ? "border-amber-400 bg-amber-50" : "border-[#FED7E4]"}`}
              />
            </div>
            {bad && <p className="mt-1 text-xs font-bold text-amber-800">Enter the age in whole years, for example 8.</p>}
            {warning && (
              <p role="alert" className="mt-1 rounded-[8px] bg-amber-50 px-2.5 py-1.5 text-xs font-bold text-amber-900">
                {warning}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
