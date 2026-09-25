import { useEffect, useState } from "react";
import { BrandStacked, Button, PageShell } from "../components/ui";
import { useAuth } from "../auth/AuthProvider";
import { apiPost } from "../lib/api";
import { goTo } from "../lib/nav";

export default function PaymentPage() {
  // Card details are collected on Stripe's hosted Checkout, never here. This
  // page just kicks off (or resumes) that secure flow for anyone landing on
  // /payment directly, then redirects.
  const { session, loading } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      goTo("/login");
      return;
    }
    apiPost<{ url?: string }>("/api/customer/stripe/subscription", { billing: "monthly" })
      .then(({ url }) => {
        if (url) window.location.href = url;
        else setError("Could not start checkout — please try again.");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Payments aren't available right now."));
  }, [session, loading]);

  return (
    <PageShell active="/pricing" auth="public">
      <main className="mx-auto max-w-[520px] px-6 py-24 text-center">
        <BrandStacked className="h-24" />
        {error ? (
          <>
            <h1 className="mt-6 text-2xl font-black">We couldn't start checkout</h1>
            <p className="mt-3 font-semibold text-[#68718f]">{error}</p>
            <Button href="/pricing" className="mt-6">Back to plans</Button>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-2xl font-black">Taking you to secure checkout…</h1>
            <p className="mt-3 font-semibold text-[#68718f]">You'll be redirected to Stripe to start your Plus subscription.</p>
          </>
        )}
      </main>
    </PageShell>
  );
}
