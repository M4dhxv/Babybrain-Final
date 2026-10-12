/** "Share → Add to Home Screen → Add" — the three taps that install the app on iPhone / iPad.
 *  Shared by the install banner and the booking-confirmed notification nudge. */
export function IosInstallSteps() {
  return (
    <ol className="mt-2.5 space-y-2 text-sm font-semibold text-baby-ink">
      <li className="flex items-center gap-2.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-palette-pinkTint text-xs font-black text-baby-cta">1</span>
        <span className="flex items-center gap-1.5">
          Tap the Share button
          <svg viewBox="0 0 24 24" className="h-5 w-5 text-baby-cta" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
          </svg>
        </span>
      </li>
      <li className="flex items-center gap-2.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-palette-pinkTint text-xs font-black text-baby-cta">2</span>
        <span>Choose <b className="font-black">Add to Home Screen</b></span>
      </li>
      <li className="flex items-center gap-2.5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-palette-pinkTint text-xs font-black text-baby-cta">3</span>
        <span>Tap <b className="font-black">Add</b>, then open BabyBrain from your Home Screen</span>
      </li>
    </ol>
  );
}
