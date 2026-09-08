import { useEffect } from "react";
import { goTo } from "../lib/nav";
import { RainbowLoader } from "./RainbowLoader";

/** No session (signed out, or the refresh token expired while the tab sat
 *  open): leave for the public landing page instead of showing a signed-in
 *  page's logged-out panel. `replace` so Back doesn't bounce straight off the
 *  gated URL again. Rendered as a placeholder while the nav happens. */
export default function RedirectToLanding() {
  useEffect(() => {
    goTo("/", { replace: true });
  }, []);
  return (
    <main data-bb-loading className="mx-auto max-w-[1180px] px-6 py-16">
      <RainbowLoader className="py-4" label="Taking you back" />
    </main>
  );
}
