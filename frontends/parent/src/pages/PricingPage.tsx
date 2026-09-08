import { useEffect, useState } from "react";
import { PageShell, Button, Icon } from "../components/ui";
import { useAuth } from "../auth/AuthProvider";
import { apiGet, apiPost } from "../lib/api";
import { goTo, getParam } from "../lib/nav";

export default function PricingPage() {
  const { session } = useAuth();
  const [billing, setBilling] = useState<"monthly" | "annual">("monthly");
  const [plan, setPlan] = useState<"free" | "plus">("free");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (getParam("billing") === "cancelled") {
      setError("Checkout cancelled — you have not been charged.");
    }
    if (!session) return;
    apiGet<{ plan: "free" | "plus" }>("/api/customer/stripe/subscription")
      .then((s) => setPlan(s.plan))
      .catch(() => {});
  }, [session]);

  async function upgrade() {
    if (!session) {
      goTo("/login");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (plan === "plus") {
        const { url } = await apiPost<{ url?: string }>("/api/customer/stripe/portal", {});
        if (url) window.location.href = url;
        return;
      }
      const { url } = await apiPost<{ url?: string }>(
        "/api/customer/stripe/subscription",
        { billing }
      );
      if (url) window.location.href = url;
      else setError("Could not start checkout — please try again.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payments aren't available right now.");
    } finally {
      setBusy(false);
    }
  }

  /* These two lists are the tier spec, so they have to describe what the app
   * actually gates. Previously Free advertised "See messages from parents and
   * class providers on booked classes" while ChatButton is gated on isPlus —
   * i.e. it promised Free users something they could not do. Messaging is
   * stated as Plus here, matching the code.
   *
   * The saved family profile and preference-based suggestions are Free: the
   * children tab and the recommendations that feed Matches are ungated. What
   * is Plus is everything behind a plusOnly tab or an isPlus check —
   * favourites, packages, make-up tokens, calendar export and messaging. */
  const freeItems = [
    "Browse & book activities",
    "Leave reviews",
    "Saved family profile",
    "Suggestions provided based on your preferences",
  ];
  const plusItems = [
    "Everything in Free",
    "Twice weekly e-mails with available activities curated for your little ones",
    "Packages & make-up tokens for all vendors stored in one place",
    "Save favourite providers",
    "Export & share booked activities in calendar view",
    "For integrated activity providers, message them & other parents booked on the same activity",
    "Priority support",
  ];
  const plusPrice = billing === "monthly" ? "9" : "99";
  const plusPeriod = billing === "monthly" ? "/mo" : "/yr";

  return (
    <PageShell active="/pricing" auth="public">
      <main className="mx-auto max-w-[960px] px-6 py-8">
        <section className="text-center">
          <Icon name="heart" className="mx-auto h-9 w-9 text-baby-pink" />
          <h1 className="mt-2 text-[36px] font-black leading-tight">
            Choose the plan that's right for your family
          </h1>
          <p className="mt-2 text-lg font-semibold text-[#68718f]">
            Discover, book and let your little ones enjoy great activities.
          </p>
          <div className="mx-auto mt-5 grid h-11 max-w-[360px] grid-cols-2 rounded-full border border-[#DCD2D5] bg-white p-1 font-black">
            <button
              type="button"
              onClick={() => setBilling("monthly")}
              className={billing === "monthly" ? "rounded-full bg-palette-blue text-white" : "text-[#59658d]"}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBilling("annual")}
              className={billing === "annual" ? "rounded-full bg-palette-blue text-white" : "text-[#59658d]"}
            >
              {/* The mock only shows the Monthly-active state. Once Annual is
                  selected the pill fills pastel blue, so the nudge takes the
                  same white label colour as the toggle text. */}
              Annual <span className={billing === "annual" ? "text-white" : "text-baby-pink"}>(1 month free)</span>
            </button>
          </div>
        </section>

        {error && (
          <p className="mx-auto mt-5 max-w-[560px] rounded-[10px] bg-[#FEF4EB] px-4 py-3 text-center text-sm font-bold text-[#FFD77A]">
            {error}
          </p>
        )}

        <section className="mt-7 grid gap-5 md:grid-cols-2">
          {/* Free */}
          <article className="relative rounded-[18px] border border-[#EBE3E5] bg-white p-6 shadow-card">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-palette-blueSoft text-palette-blueInk">
              <Icon name="heart" className="h-8 w-8 text-white" />
            </div>
            <h2 className="mt-4 text-center text-2xl font-black">Free</h2>
            <p className="mt-2 text-center">
              <span className="text-lg font-black text-[#68718f]">SGD </span>
              <span className="text-[44px] font-black text-baby-lilac">0</span>
            </p>
            <div className="my-5 border-t border-[#F4EFF0]" />
            <div className="space-y-3">
              {freeItems.map((item) => (
                <p key={item} className="flex gap-3 text-sm font-semibold leading-5">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-palette-blue text-palette-blueInk">
                    <Icon name="check" className="h-3 w-3" />
                  </span>
                  {item}
                </p>
              ))}
            </div>
          </article>

          {/* Plus */}
          <article className="relative rounded-[18px] border border-palette-blue bg-white p-6 shadow-card ring-1 ring-palette-blue/40">
            <span className="absolute left-1/2 top-[-15px] -translate-x-1/2 rounded-full bg-palette-blue px-8 py-2 text-sm font-black text-white">
              MOST POPULAR
            </span>
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#F4F0FA] text-baby-lilac">
              <Icon name="star" className="h-8 w-8" />
            </div>
            <h2 className="mt-4 text-center text-2xl font-black">Plus</h2>
            <p className="mt-2 text-center">
              <span className="text-lg font-black text-[#68718f]">SGD </span>
              <span className="text-[44px] font-black text-baby-lilac">{plusPrice}</span>
              <span className="font-bold text-[#68718f]"> {plusPeriod}</span>
            </p>
            <p className="mt-1 text-center text-sm font-black text-baby-pink">Get your first month free!</p>
            <div className="my-5 border-t border-[#F4EFF0]" />
            <div className="space-y-3">
              {plusItems.map((item) => (
                <p key={item} className="flex gap-3 text-sm font-semibold leading-5">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-palette-blue text-palette-blueInk">
                    <Icon name="check" className="h-3 w-3" />
                  </span>
                  {item}
                </p>
              ))}
            </div>
            <Button
              type="button"
              onClick={upgrade}
              disabled={busy}
              variant="blue"
              className="mt-5 w-full"
            >
              {busy
                ? "Please wait…"
                : plan === "plus"
                  ? "Manage subscription"
                  : "Upgrade to Plus"}
            </Button>
            <p className="mt-3 text-center text-xs font-semibold text-[#6D748A]">
              Auto-renews {billing === "monthly" ? "monthly" : "yearly"} after the free month. Cancel any time from your profile.
              {" "}By subscribing you agree to our{" "}
              <a href="/terms" className="text-palette-blue underline">Terms &amp; Conditions</a>.
            </p>
          </article>
        </section>
      </main>
    </PageShell>
  );
}
