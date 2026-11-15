import { parseAge } from "../lib/addonAges";
import { ageProblem, typeWord, type CompanionType } from "../lib/companions";

/**
 * The free companion(s) a class includes with each ticket (migration 00273, companion mode): a notice,
 * then a name and age box per companion. If a name is given the age is required, and the age must
 * match the type the vendor chose (adult 15 and over, child 12 and under), so a mismatch is flagged
 * on the spot and the parent can't continue until it is fixed. Leaving a row blank is fine.
 */
export function CompanionFields({
  type,
  slots,
  tickets,
  ticketLabels,
  names,
  ages,
  onName,
  onAge,
}: {
  type: CompanionType;
  slots: number;
  tickets: number;
  /** A friendly label for each ticket, e.g. the child's name. */
  ticketLabels: string[];
  names: string[];
  ages: string[];
  onName: (i: number, v: string) => void;
  onAge: (i: number, v: string) => void;
}) {
  const word = type === "adult" ? "adult" : "child";
  return (
    <section>
      <h3 className="mb-2 text-lg font-black">
        {slots === 1 ? `Free ${word} companion` : `${slots} free ${word} companions`} <span className="text-sm font-semibold text-[#59658d]">(included with each ticket)</span>
      </h3>
      <p className="mb-3 rounded-[10px] bg-[#FFF5F8] p-3 text-sm font-semibold text-[#59658d]">
        Every ticket for this class includes {slots === 1 ? "one" : slots} free {word} {slots === 1 ? "companion" : "companions"}, at no extra cost.
        Add {slots === 1 ? "their" : "each person's"} name and age so the provider knows who is coming. Both are needed, so we can check
        the companion is {typeWord(type)}. Leave it blank if no one is coming. You can change this later from My bookings, up to the start of the class.
      </p>
      <div className="space-y-3">
        {Array.from({ length: tickets }).map((_, seat) => (
          <div key={seat} className="rounded-[12px] border border-[#DCD2D5] bg-white p-3">
            {tickets > 1 && <div className="mb-2 text-sm font-black">With {ticketLabels[seat] || `ticket ${seat + 1}`}</div>}
            <div className="space-y-3">
              {Array.from({ length: slots }).map((__, k) => {
                const i = seat * slots + k;
                const typed = (ages[i] ?? "").trim();
                const age = parseAge(ages[i]);
                const problem = age !== null ? ageProblem(type, age) : null;
                const needsAge = (names[i] ?? "").trim() !== "" && age === null;
                const needsName = (names[i] ?? "").trim() === "" && (age !== null || typed !== "");
                return (
                  <div key={k}>
                    <div className="flex gap-2">
                      <input
                        value={names[i] ?? ""}
                        maxLength={80}
                        autoComplete="off"
                        autoCapitalize="words"
                        onChange={(e) => onName(i, e.target.value)}
                        placeholder={slots > 1 ? `Companion ${k + 1} name` : "Companion name"}
                        aria-label={`Companion ${k + 1} name${tickets > 1 ? ` for ticket ${seat + 1}` : ""}`}
                        aria-invalid={needsName}
                        className={`min-w-0 flex-1 rounded-[10px] border px-3 py-2 text-sm font-semibold ${needsName ? "border-amber-400 bg-amber-50" : "border-[#FED7E4]"}`}
                      />
                      <input
                        value={ages[i] ?? ""}
                        inputMode="numeric"
                        maxLength={3}
                        autoComplete="off"
                        onChange={(e) => onAge(i, e.target.value.replace(/\D/g, ""))}
                        placeholder="Age"
                        aria-label={`Companion ${k + 1} age in years${tickets > 1 ? ` for ticket ${seat + 1}` : ""}`}
                        aria-invalid={problem != null || needsAge}
                        className={`w-24 shrink-0 rounded-[10px] border px-3 py-2 text-sm font-semibold ${problem || needsAge ? "border-amber-400 bg-amber-50" : "border-[#FED7E4]"}`}
                      />
                    </div>
                    {needsName && <p className="mt-1 text-xs font-bold text-amber-800">Enter their name as well as their age.</p>}
                    {needsAge && <p className="mt-1 text-xs font-bold text-amber-800">Enter their age so we can check they are {typeWord(type)}.</p>}
                    {typed !== "" && age === null && <p className="mt-1 text-xs font-bold text-amber-800">Enter the age in whole years, for example 34.</p>}
                    {problem && (
                      <p role="alert" className="mt-1 rounded-[8px] bg-amber-50 px-2.5 py-1.5 text-xs font-bold text-amber-900">
                        {problem} {type === "adult" ? "A child can't use the adult companion place." : "An adult can't use the child companion place."} You can&rsquo;t continue until this is fixed.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
