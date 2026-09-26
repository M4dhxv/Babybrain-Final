import { useEffect, useState } from "react";
import { Button, Footer, Icon, PageShell } from "../components/ui";
import { AvatarPicker } from "../components/AvatarPicker";
import RedirectToLanding from "../components/RedirectToLanding";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { geocodePostal } from "../lib/geocode";
import { PARENT_AVATARS } from "../lib/avatars";
import { postcodeError } from "../lib/validation";
import { Chip, TIME_CHIPS, BUDGET_CHIPS, REGION_FILTERS, budgetRange } from "./prefChips";

/** Edit an existing parent profile.
 *
 *  QA: "When you click edit profile, the form should be pre-populated with what
 *  you have completed before rather than having to do it all again" and "Tried
 *  to edit profile and it added a child instead". Both came from Edit Profile
 *  pointing at /onboarding — the sign-up form, which always inserts a new
 *  child. Children are managed on their own tab; this page never creates one.
 */
export default function EditProfilePage() {
  const { session, profile, children: kids, loading, refresh } = useAuth();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [postcode, setPostcode] = useState("");
  const [avatarSeed, setAvatarSeed] = useState<string | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [times, setTimes] = useState<string[]>([]);
  // QA: "Under account, edit profile, can only select one budget — should be
  // able to select multiple." Sign-up already worked this way: the parent
  // ticks any number of bands and we store the span they cover.
  const [budgets, setBudgets] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Prefill from what the parent has already told us.
  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? "");
    setPhone(profile.phone ?? "");
    setPostcode(profile.postal_code ?? "");
    setAvatarSeed(profile.avatar_seed ?? null);
  }, [profile]);

  useEffect(() => {
    if (!session) return;
    supabase
      .from("user_preferences")
      .select("preferred_days, preferred_times, preferred_regions, budget_min, budget_max")
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setDays(data.preferred_days ?? []);
          setTimes(data.preferred_times ?? []);
          setRegions(data.preferred_regions ?? []);
          // Stored as one min/max span; tick every band that span covers.
          const lo = data.budget_min;
          const hi = data.budget_max;
          if (lo != null || hi != null) {
            setBudgets(
              BUDGET_CHIPS.filter(
                ([, , bLo, bHi]) =>
                  (lo == null || (bHi ?? Infinity) > lo) && (hi == null || (bLo ?? 0) < hi)
              ).map(([k]) => k)
            );
          }
        }
        setReady(true);
      });
  }, [session]);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const input = "h-11 w-full rounded-[10px] border border-[#FED7E4] px-3 text-sm font-semibold";
  const weekdayKeys = ["mon", "tue", "wed", "thu", "fri"];
  const weekendKeys = ["sat", "sun"];
  const weekdaysOn = weekdayKeys.every((d) => days.includes(d));
  const weekendOn = weekendKeys.every((d) => days.includes(d));

  async function save() {
    if (!session) return;
    if (!fullName.trim()) return setError("Please add your full name.");
    const postcodeProblem = postcodeError(postcode);
    if (postcodeProblem) return setError(postcodeProblem);
    setBusy(true);
    setError(null);
    // Best-effort — see geocode.ts. Re-resolved on every save (not just when
    // the postcode changed) so a parent who never touched location before
    // this fix still gets coordinates the next time they save their profile.
    const coords = await geocodePostal(postcode);
    const { error: pErr } = await supabase
      .from("parent_profiles")
      .update({
        full_name: fullName.trim(),
        phone: phone.trim() || null,
        postal_code: postcode.trim(),
        avatar_seed: avatarSeed,
        ...(coords ? { latitude: coords.latitude, longitude: coords.longitude } : {}),
      })
      .eq("id", session.user.id);
    // QA: "interests show up under the parent section — remove, interests are
    // associated with the child". They still drive parent-level
    // recommendations, so we keep the column in step with the children's own
    // interests rather than asking for them twice.
    const { error: prefErr } = await supabase
      .from("user_preferences")
      .update({
        preferred_days: days as never,
        preferred_times: times as never,
        preferred_regions: regions as never,
        interests: [...new Set(kids.flatMap((c) => c.interests))],
        ...budgetRange(budgets),
      })
      .eq("user_id", session.user.id);
    setBusy(false);
    if (pErr || prefErr) return setError((pErr ?? prefErr)!.message);
    await refresh();
    setSaved(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (!loading && !session) return <RedirectToLanding />;

  return (
    <PageShell active="/profile">
      <main className="mx-auto max-w-[680px] px-6 py-6">
        <a href="/profile" className="text-sm font-bold text-baby-lilac">← Back to my account</a>
        <h1 className="mt-3 text-[30px] font-black">Edit your profile</h1>
        <p className="mt-1 text-sm font-semibold text-[#44507b]">Update your details and what you'd like us to suggest.</p>

        {saved && (
          <p className="mt-4 rounded-[10px] bg-[#F1FBEF] px-4 py-3 text-sm font-bold text-palette-green">
            Your profile has been updated.
          </p>
        )}

        <section className="mt-4 rounded-[14px] border border-[#FEE9D7] bg-white p-5">
          <h2 className="font-black">Your avatar</h2>
          <p className="mt-1 text-xs font-semibold text-[#6D748D]">Pick the one you like — it shows on your account and in session chats.</p>
          <AvatarPicker
            options={PARENT_AVATARS}
            value={avatarSeed}
            onChange={setAvatarSeed}
            kind="parent"
            fallbackSeed={fullName}
          />
        </section>

        <section className="mt-4 rounded-[14px] border border-[#FEE9D7] bg-white p-5">
          <h2 className="font-black">Your details</h2>
          <div className="mt-3 space-y-3">
            <div><label className="mb-1 block text-sm font-black">Full name</label><input className={input} value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="mb-1 block text-sm font-black">Phone</label><input className={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="8123 4567" /></div>
              <div><label className="mb-1 block text-sm font-black">Postcode</label><input className={input} inputMode="numeric" maxLength={6} value={postcode} onChange={(e) => setPostcode(e.target.value.replace(/\D/g, ""))} /></div>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-[#6D748A]">Email</p>
              <p className="font-black">{session?.user.email}</p>
              <p className="text-xs font-semibold text-[#6D748D]">Contact us if you need to change the email on your account.</p>
            </div>
          </div>
        </section>

        <section className="mt-4 rounded-[14px] border border-[#FEE9D7] bg-white p-5">
          <h2 className="flex items-center gap-2 font-black"><Icon name="pin" className="h-4 w-4 text-baby-pink" /> Areas you'd like activities in</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {REGION_FILTERS.map(([v, l]) => (
              <Chip key={v} on={regions.includes(v)} onClick={() => toggle(regions, v, setRegions)}>{l}</Chip>
            ))}
          </div>

          <h2 className="mt-5 flex items-center gap-2 font-black"><Icon name="heart" className="h-4 w-4 text-baby-pink" /> Your preferences</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <Chip
              on={weekdaysOn}
              onClick={() => setDays((d) => (weekdaysOn ? d.filter((x) => !weekdayKeys.includes(x)) : [...new Set([...d, ...weekdayKeys])]))}
            >
              Weekdays
            </Chip>
            <Chip
              on={weekendOn}
              onClick={() => setDays((d) => (weekendOn ? d.filter((x) => !weekendKeys.includes(x)) : [...new Set([...d, ...weekendKeys])]))}
            >
              Weekend
            </Chip>
            {TIME_CHIPS.map(([v, l]) => <Chip key={v} on={times.includes(v)} onClick={() => toggle(times, v, setTimes)}>{l}</Chip>)}
            {BUDGET_CHIPS.map(([k, l]) => (
              <Chip key={k} on={budgets.includes(k)} onClick={() => toggle(budgets, k, setBudgets)}>{l}</Chip>
            ))}
          </div>

        </section>

        <section className="mt-4 flex items-center justify-between gap-3 rounded-[14px] border border-[#FEE9D7] bg-[#FFF5F8] p-5">
          <div>
            <h2 className="font-black">Your children</h2>
            <p className="mt-1 text-sm font-semibold text-[#59658d]">Add, edit or remove a child on their own tab — editing your profile never changes them.</p>
          </div>
          <Button href="/profile?tab=children" variant="outline" className="shrink-0"><Icon name="people" className="h-4 w-4" /> Manage children</Button>
        </section>

        {error && (
          <p role="alert" className="mt-4 rounded-[10px] border border-[#FED7E4] bg-[#FEEBF2] px-4 py-3 text-sm font-bold text-baby-cta">{error}</p>
        )}
        <div className="mt-4 flex gap-3">
          <Button type="button" onClick={save} disabled={busy || !ready}>{busy ? "Saving…" : "Save changes"}</Button>
          <Button href="/profile" variant="outline">Cancel</Button>
        </div>
      </main>
      <Footer />
    </PageShell>
  );
}
