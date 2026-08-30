# BabyBrain × Wix — Vendor Briefing

*Prepared for the founder / vendor meeting. Explains the Wix Bookings integration from the vendor's (activity provider's) point of view.*

## The short version

If a vendor already manages their class/appointment schedule in **Wix Bookings**, BabyBrain can pull that schedule in live and let parents book directly through BabyBrain — without the vendor re-entering their calendar in two places. A booking made on BabyBrain shows up in the vendor's own Wix dashboard automatically, exactly like a booking made through their own website.

## How it works today

- The vendor keeps managing their availability **in Wix**, the same way they do now.
- BabyBrain reads that availability **live** every time a parent looks at the listing — there's no separate copy of the schedule sitting in BabyBrain that could go stale or double-book.
- When a parent books on BabyBrain, BabyBrain creates the booking **in Wix** on the vendor's behalf, then keeps its own record too. The vendor sees the parent's booking in their Wix calendar just like any other booking.
- Both **1:1 appointments** (e.g. a private class with a specific instructor) and **group classes** (with real seat capacity) are supported — BabyBrain reads which type a service is and handles the two differently, since Wix itself treats them as separate systems.

## What changes for the vendor

- **Nothing about their day-to-day Wix use.** They keep creating/editing classes and time slots in Wix exactly as before.
- Their listing on BabyBrain now shows real, live availability instead of a manually maintained schedule.
- Bookings from BabyBrain parents land in their existing Wix bookings list/calendar — no new tool to check.

## What stays the same for every other vendor

**Wix is entirely optional.** A vendor who doesn't use Wix registers and runs their listing exactly as BabyBrain already works today — creating classes and sessions directly in the BabyBrain vendor portal. Nothing about the standard signup, claim, or booking flow requires Wix.

## Benefits for a Wix-using vendor

- **No double data entry** — one calendar (Wix) stays the single source of truth.
- **No overbooking risk** — every slot shown to a parent is fetched fresh from Wix at the moment they look, not cached.
- **Fits existing operations** — the vendor's staff keep using the Wix dashboard/app they already know.
- **Works for both appointment- and class-style services.**

## What's needed from the vendor

Two pieces of information from their Wix account: an **API Key** and their **Site ID**. Both are covered — including exactly how to find them in the Wix dashboard — in the companion document, *Wix Integration Requirements & Booking Workflow*.

## Current limitations — set expectations accordingly

This integration has been built and verified end-to-end in a local test environment (real bookings created against a Wix sandbox site, confirmed on both sides), but it is **not yet live in production**, and a few things are intentionally out of scope for this first version:

- **No self-service "Connect Wix" button yet.** Linking a vendor's Wix account today is a manual, one-time setup step done by BabyBrain's team using the credentials the vendor provides — not something the vendor does themselves in the portal.
- **Cancellations/reschedules don't sync back to Wix yet.** If a booking is cancelled or rescheduled from the BabyBrain side, that change is *not* automatically reflected in the vendor's Wix calendar. Until this is built, the vendor's team should double-check Wix directly for cancellations made on BabyBrain.
- **Wix-linked bookings are free bookings for now** — payment/Stripe checkout isn't wired up for Wix-sourced classes yet, so this path currently assumes no charge is collected through BabyBrain at booking time.
- **One Wix site per vendor** — the current design assumes each vendor connects one Wix account/site.

## Data shared with Wix

When a parent books through BabyBrain, their name, email, and phone number are sent to Wix as part of creating the booking there — the vendor will see this contact information in their Wix bookings list, the same as for any booking made directly on their own site.
