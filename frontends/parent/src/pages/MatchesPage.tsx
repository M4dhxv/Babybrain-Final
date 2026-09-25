import { useState } from "react";
import {
  ActivityCard,
  AnimalAvatar,
  Button,
  CategoryTile,
  Footer,
  PageShell,
  SectionTitle,
} from "../components/ui";
import { categories } from "../data/content";
import { useAuth } from "../auth/AuthProvider";
import { useRecommendations, toCard } from "../lib/data";
import { formatChildAge } from "../lib/database.types";
import RedirectToLanding from "../components/RedirectToLanding";
import { ActivityCardGridSkeleton, ChildCardSkeleton } from "../components/Skeletons";

export default function MatchesPage({ active = "/matches" }: { active?: string }) {
  const { session, profile, children, loading, dataResolved } = useAuth();
  const { data: recsByChild, loading: recsLoading } = useRecommendations(children);
  // A stored session renders this page on the first paint, before the
  // profile/children lookup answers. Until it does an empty child list means
  // "unknown", not "none" — hold the skeletons rather than an empty page.
  const pending = recsLoading || (Boolean(session) && !dataResolved);
  // Which child's suggestions are on screen; defaults to the first.
  const [homeChildId, setHomeChildId] = useState<string | null>(null);

  if (!loading && !session) return <RedirectToLanding />;
  // Only claim there are no children once the fetch has actually answered —
  // an unresolved lookup used to send signed-in parents to onboarding.
  if (!loading && dataResolved && children.length === 0) {
    return (
      <PageShell active={active}>
        <main className="mx-auto max-w-[1180px] px-6 py-16 text-center">
          <p className="text-xl font-black">Tell us about your child to get matches.</p>
          <Button href="/onboarding" className="mt-4">Complete your profile</Button>
        </main>
      </PageShell>
    );
  }

  /* QA: "How do I know which child the suggested activities are for? On Home
     page just see one child?" — recommendations have always been per child
     (user_recommendations.child_id), but Home silently showed the first
     child's and never said so. The name is now on the heading and, with more
     than one child, a chip switches between them. */
  const shown = recsByChild.find((r) => r.child.id === homeChildId) ?? recsByChild[0];
  const child = shown?.child;
  const firstName = profile?.full_name?.split(" ")[0] ?? "there";

  return (
    <PageShell active={active}>
      <main className="mx-auto max-w-[1180px] px-6 py-6">
        <section>
          <div className="grid items-center gap-6 lg:grid-cols-[1fr_340px]">
            <div>
              {/* The greeting is the page header; the suggestion line sits a
                  step below it. */}
              <h1 className="text-[36px] font-black leading-tight">
                Hi{" "}
                <span className="text-baby-lilac">
                  {profile || dataResolved ? (
                    firstName
                  ) : (
                    <span aria-hidden="true" className="inline-block h-8 w-28 animate-pulse rounded-lg bg-[#F3EDF0] align-middle" />
                  )}
                </span>
                !
              </h1>
              <p className="mt-2 text-[26px] font-black leading-tight">
                Here are some suggested activities for <span className="text-baby-lilac">{child?.name ?? "your child"}</span>
              </p>
              <p className="mt-4 text-[17px] font-semibold text-[#47527d]">Based on age, interests and your preferences.</p>
              {recsByChild.length > 1 && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-[#6D748A]">Suggestions for</span>
                  {recsByChild.map((r) => {
                    const on = r.child.id === (child?.id ?? null);
                    return (
                      <button
                        key={r.child.id}
                        type="button"
                        onClick={() => setHomeChildId(r.child.id)}
                        aria-pressed={on}
                        className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                          on ? "bg-[#FED7E4] text-baby-cta" : "border border-[#EBE3E5] bg-white text-[#6D748A] hover:border-baby-pink"
                        }`}
                      >
                        {r.child.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {child ? (
              <article className="flex gap-4 rounded-[18px] border border-[#EBE3E5] bg-white p-4 shadow-card">
                <AnimalAvatar seed={child.avatar_seed ?? child.name} kind="child" gender={child.gender} className="h-32 w-32 ring-8 ring-[#FEEBF2]" />
                <div>
                  <h2 className="text-xl font-black">{child.name}</h2>
                  <p className="mb-3 font-bold">{formatChildAge(child.date_of_birth)}</p>
                  {child.interests.map((item) => (
                    <p key={item} className="mb-1.5 rounded-full bg-[#FEF4EB] px-3 py-1.5 text-xs font-bold text-[#596184]">enjoys {item.replace(/-/g, " ")}</p>
                  ))}
                </div>
              </article>
            ) : (
              (loading || pending) && <ChildCardSkeleton />
            )}
          </div>
        </section>

        <section className="mt-6">
          {/* On mobile the "See activity options" link sits below the cards
              rather than crowding the heading. */}
          <SectionTitle
            action={<a href="/explore" className="hidden font-bold text-[#FFC1D6] sm:inline">Explore more activities →</a>}
          >
            {child ? `Matching activities for ${child.name}` : "Matching activities"}
          </SectionTitle>
          {pending ? (
            <ActivityCardGridSkeleton count={4} />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {(shown?.recs ?? []).slice(0, 4).map((r) =>
                r.activity ? <ActivityCard key={r.id} activity={toCard(r.activity)} /> : null
              )}
              {shown && shown.recs.length === 0 && <p className="font-semibold text-[#68718f]">No matches yet — new activities are added regularly.</p>}
            </div>
          )}
          <a href="/explore" className="mt-4 block text-left font-bold text-[#FFC1D6] sm:hidden">Explore more activities →</a>
        </section>

        <section className="mt-6">
          <SectionTitle>Explore activities by type</SectionTitle>
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
            {categories.map(([icon, label, copy, slug]) => (
              <CategoryTile key={label} icon={icon} label={label} copy={copy} href={`/explore?cat=${slug}`} />
            ))}
          </div>
        </section>
      </main>
      {/* Signed-in parents land here instead of the marketing home, and this
          page was the one route that never rendered the footer. */}
      <Footer />
    </PageShell>
  );
}
