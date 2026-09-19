import { useEffect, useState } from "react";
import { goTo, routePath } from "../lib/nav";
import { RainbowLoader } from "./RainbowLoader";

/** No session (signed out, or the refresh token expired while the tab sat
 *  open): send them to log in instead of showing a signed-in page's logged-out
 *  panel, carrying the page they were after as `?next=` so logging in lands
 *  them back on it. Email links (a freed waitlist spot, a make-up token, a
 *  booking) all point at gated pages; dropping the destination sent every
 *  parent who wasn't already signed in to the landing page, and then to their
 *  profile overview after logging in, so "Book now" never got them to the
 *  booking. `replace` so Back doesn't bounce straight off the gated URL again.
 *  Rendered as a placeholder while the nav happens.
 *
 *  (Named for what it used to do — it went to the landing page. The login page
 *  only honours same-origin relative `next` values, so this can't be used as an
 *  open redirect.) */
export default function RedirectToLanding() {
  // Captured at first render, before the redirect rewrites the URL: an effect
  // that re-ran (React StrictMode runs each one twice in dev) would otherwise
  // read the login URL and nest it inside its own `next`.
  const [dest] = useState(() => routePath() + window.location.search + window.location.hash);
  useEffect(() => {
    goTo(`/login?next=${encodeURIComponent(dest)}`, { replace: true });
  }, [dest]);
  return (
    <main data-bb-loading className="mx-auto max-w-[1180px] px-6 py-16">
      <RainbowLoader className="py-4" label="Taking you to log in" />
    </main>
  );
}
