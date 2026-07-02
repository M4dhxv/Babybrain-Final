# BabyBrain.sg Component Rebuild Analysis

## Source Screens

The supplied PPTX contains seven flattened PNG reference screens. They are kept only in `design-source/assets` as visual references. Full screenshots are not served or rendered by the app.

| Screen | Reference | Route | Implementation |
| --- | --- | --- | --- |
| Home | `image1.png` | `/` | Real hero, feature strip, process panel, category grid, cards, reviews, CTA, footer |
| Onboarding | `image2.png` | `/onboarding` | Three coded form panels with inputs, chips, steppers, and action buttons |
| Matched Classes | `image3.png` | `/matches` | Coded matched hero, profile/rationale cards, activity cards, preference tiles |
| Explore Activities | `image4.png` | `/explore` | Coded filter controls, result cards, map panel, pagination |
| Activity Detail | `image5.png` | `/activity` | Coded detail page, image gallery, booking sidebar, tabs, info columns |
| Parent Dashboard | `image6.png` | `/profile` | Coded sidebar, profile card, class grids, quick access tiles |
| Contact | `image7.png` | `/contact` | Coded support hero, contact method cards, FAQ details, help CTA |

## Layout Hierarchy

- Global navigation: real `<header>` and `<nav>`, logo left, route links center, auth/user actions right.
- Home: two-column hero, three feature callouts, rounded process panel, category tile grid, activity card grid, review cards, gradient CTA, footer.
- Onboarding: three equal form surfaces on desktop, each with real inputs/buttons and progress indicators.
- Matches: profile-aware recommendation hero, rationale card, four activity cards, preference option tiles.
- Explore: filter row, list/map split, coded result rows, real search input, map artwork inside a panel.
- Activity detail: summary column, real gallery image region, booking CTA sidebar, tab buttons, four-column information area.
- Dashboard: sidebar navigation, child summary panel, upcoming/attended card grids, quick access controls.
- Contact: support hero, four tall contact cards with real buttons, native `<details>` FAQ rows, CTA band.

## Grid Structure And Spacing

- Main desktop containers use `max-width` values from 1024px to 1180px to mirror the screenshots.
- Primary page padding is 24px horizontally with 28-44px vertical section rhythm.
- Card gaps are 12-24px depending on density; major sections use 28-40px separation.
- Four-column activity and contact grids collapse to two/one columns on smaller screens.
- Onboarding preserves the wide reference composition with three side-by-side coded panels on large screens.

## Typography Hierarchy

- Rounded sans stack: Nunito, Avenir Next, Inter, system UI.
- Hero headings: 36-56px, `font-black`, deep navy.
- Page headings: 30-42px, `font-black`.
- Section headings: 24-28px, `font-black`.
- Card titles: 16-20px, `font-black`.
- Body text: 12-18px, medium/semi-bold, muted navy.
- CTA labels: bold to extra-bold, 12-18px.

## Palette

- Paper background: `#FFFCF8`.
- Deep navy: `#111A4C`.
- Primary blue: `#4597F7`.
- Hot pink: `#FA5D93`.
- Lilac: `#9568DF`.
- Muted copy: `#44507B`, `#59658D`, `#68718F`.
- Borders: pale blue-gray and warm peach tints.
- Panels: white, blue wash, pink wash, cream wash, pale green/lilac gradients.

## Corners, Shadows, And Borders

- Buttons and inputs: 8-12px radius.
- Cards: 12-18px radius.
- Large panels: 18-22px radius.
- Hero imagery: large asymmetric rounded corners to match the soft blob-like crop.
- Borders: 1px low-contrast strokes.
- Shadows: subtle blue-tinted card shadows and slightly stronger floating button shadows.

## Component Inventory

- `Header`, `Brand`, `Footer`
- `Button`
- `PageShell`
- `SectionTitle`
- `ActivityCard`
- `ActivityRow`
- `CategoryTile`
- `MiniActivityGrid`
- `Field`, `PreferenceChips`, `InfoBlock`
- Route pages: `HomePage`, `OnboardingPage`, `MatchesPage`, `ExplorePage`, `ActivityDetailPage`, `ProfilePage`, `ContactPage`

## Asset Policy

- Full screenshots are not used as page content.
- Cropped image assets are used only where the design contains real images: logo mascot, family/class photos, child/avatar images, support character art, map artwork, and CTA illustration.
- All visible page structure, text, buttons, inputs, cards, nav, filters, FAQ rows, tabs, and controls are React/Tailwind components.

## Interaction Notes

- Navigation links move between routes.
- Buttons are real `<button>` or `<a>` controls.
- Forms use real `<input>` elements.
- FAQ rows use native `<details>` elements.
- Text is selectable because it is rendered as HTML text, not flattened screenshot text.

## QA Notes

- Current estimated similarity: 85-90% across the set after componentization.
- The prior 99% screenshot-surface approach was removed because it did not meet functional frontend criteria.
- Remaining visual gaps are mostly icon exactness, photo crop precision, map marker recreation, and highly detailed decorative flourishes.
- Manual review should compare each route against the PPTX references and tune spacing/copy/icon details where exactness matters most.
