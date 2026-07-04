# Graph Report - babybrain-clone  (2026-07-04)

## Corpus Check
- 197 files · ~182,548 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1186 nodes · 2091 edges · 82 communities (75 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0552b718`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_cn|cn]]
- [[_COMMUNITY_dependencies|dependencies]]
- [[_COMMUNITY_sidebar.tsx|sidebar.tsx]]
- [[_COMMUNITY_createAdminClient|createAdminClient]]
- [[_COMMUNITY_database.ts|database.ts]]
- [[_COMMUNITY_icons.tsx|icons.tsx]]
- [[_COMMUNITY_App.tsx|App.tsx]]
- [[_COMMUNITY_utils.ts|utils.ts]]
- [[_COMMUNITY_database.types.ts|database.types.ts]]
- [[_COMMUNITY_createClient|createClient]]
- [[_COMMUNITY_dependencies|dependencies]]
- [[_COMMUNITY_database.types.ts|database.types.ts]]
- [[_COMMUNITY_devDependencies|devDependencies]]
- [[_COMMUNITY_devDependencies|devDependencies]]
- [[_COMMUNITY_alert-dialog.tsx|alert-dialog.tsx]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_client.ts|client.ts]]
- [[_COMMUNITY_ui.tsx|ui.tsx]]
- [[_COMMUNITY_command.tsx|command.tsx]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_components.json|components.json]]
- [[_COMMUNITY_App.tsx|App.tsx]]
- [[_COMMUNITY_field.tsx|field.tsx]]
- [[_COMMUNITY_compilerOptions|compilerOptions]]
- [[_COMMUNITY_data.ts|data.ts]]
- [[_COMMUNITY_menubar.tsx|menubar.tsx]]
- [[_COMMUNITY_SettingsPage.tsx|SettingsPage.tsx]]
- [[_COMMUNITY_AuthProvider.tsx|AuthProvider.tsx]]
- [[_COMMUNITY_BookingsPage.tsx|BookingsPage.tsx]]
- [[_COMMUNITY_context-menu.tsx|context-menu.tsx]]
- [[_COMMUNITY_dropdown-menu.tsx|dropdown-menu.tsx]]
- [[_COMMUNITY_carousel.tsx|carousel.tsx]]
- [[_COMMUNITY_BabyBrain Phase 1 — Backend Architecture|BabyBrain Phase 1 — Backend Architecture]]
- [[_COMMUNITY_input-group.tsx|input-group.tsx]]
- [[_COMMUNITY_item.tsx|item.tsx]]
- [[_COMMUNITY_validate.mjs|validate.mjs]]
- [[_COMMUNITY_BabyBrain.sg Component Rebuild Analysis|BabyBrain.sg Component Rebuild Analysis]]
- [[_COMMUNITY_form.tsx|form.tsx]]
- [[_COMMUNITY_crawl-vendors.mjs|crawl-vendors.mjs]]
- [[_COMMUNITY_BabyBrain — Setup Status & Remaining Steps|BabyBrain — Setup Status & Remaining Steps]]
- [[_COMMUNITY_BabyBrain Phase 2 — VendorProvider Backend Architecture|BabyBrain Phase 2 — Vendor/Provider Backend Architecture]]
- [[_COMMUNITY_useActivities.ts|useActivities.ts]]
- [[_COMMUNITY_chart.tsx|chart.tsx]]
- [[_COMMUNITY_drawer.tsx|drawer.tsx]]
- [[_COMMUNITY_api.ts|api.ts]]
- [[_COMMUNITY_ActivitiesPage.tsx|ActivitiesPage.tsx]]
- [[_COMMUNITY_middleware.ts|middleware.ts]]
- [[_COMMUNITY_enrich-gemini.mjs|enrich-gemini.mjs]]
- [[_COMMUNITY_breadcrumb.tsx|breadcrumb.tsx]]
- [[_COMMUNITY_empty.tsx|empty.tsx]]
- [[_COMMUNITY_DashboardPage.tsx|DashboardPage.tsx]]
- [[_COMMUNITY_validate-vendor.mjs|validate-vendor.mjs]]
- [[_COMMUNITY_BabyBrain Phase 2 — Vendor backend setup & API reference|BabyBrain Phase 2 — Vendor backend setup & API reference]]
- [[_COMMUNITY_tsconfig.json|tsconfig.json]]
- [[_COMMUNITY_layout.tsx|layout.tsx]]
- [[_COMMUNITY_input-otp.tsx|input-otp.tsx]]
- [[_COMMUNITY_enrich-regex.mjs|enrich-regex.mjs]]
- [[_COMMUNITY_alert.tsx|alert.tsx]]
- [[_COMMUNITY_seed.mjs|seed.mjs]]
- [[_COMMUNITY_vercel.json|vercel.json]]
- [[_COMMUNITY_route.ts|route.ts]]
- [[_COMMUNITY_React + TypeScript + Vite|React + TypeScript + Vite]]
- [[_COMMUNITY_validate-vendor-integrations.mjs|validate-vendor-integrations.mjs]]
- [[_COMMUNITY_page.tsx|page.tsx]]
- [[_COMMUNITY_sonner|sonner]]
- [[_COMMUNITY_next.config.mjs|next.config.mjs]]

## God Nodes (most connected - your core abstractions)
1. `cn()` - 286 edges
2. `createAdminClient()` - 25 edges
3. `createClient()` - 24 edges
4. `base()` - 22 edges
5. `compilerOptions` - 22 edges
6. `useAuth()` - 21 edges
7. `Button()` - 19 edges
8. `compilerOptions` - 18 edges
9. `compilerOptions` - 16 edges
10. `compilerOptions` - 16 edges

## Surprising Connections (you probably didn't know these)
- `MyReviewsPage()` --calls--> `createClient()`  [EXTRACTED]
  app/dashboard/reviews/page.tsx → lib/supabase/server.ts
- `POST()` --calls--> `createClient()`  [EXTRACTED]
  app/api/geocode/route.ts → lib/supabase/server.ts
- `POST()` --calls--> `createAdminClient()`  [EXTRACTED]
  app/api/webhooks/notifications/route.ts → lib/supabase/admin.ts
- `POST()` --calls--> `createAdminClient()`  [EXTRACTED]
  app/api/webhooks/stream/route.ts → lib/supabase/admin.ts
- `GET()` --calls--> `createClient()`  [EXTRACTED]
  app/auth/callback/route.ts → lib/supabase/server.ts

## Import Cycles
- None detected.

## Communities (82 total, 7 thin omitted)

### Community 0 - "cn"
Cohesion: 0.05
Nodes (53): AccordionContent(), AccordionItem(), AccordionTrigger(), Avatar(), AvatarFallback(), AvatarImage(), Badge(), badgeVariants (+45 more)

### Community 1 - "dependencies"
Cohesion: 0.04
Nodes (49): dependencies, class-variance-authority, clsx, cmdk, date-fns, embla-carousel-react, @hookform/resolvers, lucide-react (+41 more)

### Community 2 - "sidebar.tsx"
Cohesion: 0.06
Nodes (40): Sheet(), SheetContent(), SheetDescription(), SheetFooter(), SheetHeader(), SheetOverlay(), SheetTitle(), Sidebar() (+32 more)

### Community 3 - "createAdminClient"
Cohesion: 0.14
Nodes (25): POST(), POST(), GET(), POST(), GET(), POST(), POST(), POST() (+17 more)

### Community 4 - "database.ts"
Cohesion: 0.06
Nodes (36): BUDGET_CHIPS, OnboardingPage(), TIME_CHIPS, WEEKDAYS, WEEKENDS, Activity, ActivityCategory, ActivitySearchResult (+28 more)

### Community 5 - "icons.tsx"
Cohesion: 0.14
Nodes (28): AGE_OPTIONS, DISTANCE_OPTIONS, FavProps, base(), IconArrowLeft(), IconArrowRight(), IconBell(), IconBookmark() (+20 more)

### Community 6 - "App.tsx"
Cohesion: 0.11
Nodes (22): ActivityDetailPage(), BookedPage(), BookingPage(), BUDGET_CHIPS, ForgotPasswordPage(), getParam(), LoginPage(), MatchesPage() (+14 more)

### Community 7 - "utils.ts"
Cohesion: 0.43
Nodes (5): ToggleGroup(), ToggleGroupContext, ToggleGroupItem(), Toggle(), toggleVariants

### Community 8 - "database.types.ts"
Cohesion: 0.06
Nodes (28): ActivitySearchResult, ActivitySession, AppNotification, Attendance, Booking, BookingStatus, Child, EmailStatus (+20 more)

### Community 9 - "createClient"
Cohesion: 0.18
Nodes (23): ActivityDetailPage(), GET(), POST(), FavoritesPage(), DashboardPage(), ExplorePage(), RootLayout(), MatchesPage() (+15 more)

### Community 10 - "dependencies"
Cohesion: 0.07
Nodes (29): dependencies, next, react, react-dom, resend, stream-chat, stream-chat-react, stripe (+21 more)

### Community 11 - "database.types.ts"
Cohesion: 0.07
Nodes (28): ActivityCategory, ActivitySearchResult, AppNotification, Attendance, Booking, BookingStatus, EmailStatus, Favorite (+20 more)

### Community 12 - "devDependencies"
Cohesion: 0.07
Nodes (28): devDependencies, autoprefixer, eslint, @eslint/js, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals, kimi-plugin-inspect-react (+20 more)

### Community 13 - "devDependencies"
Cohesion: 0.08
Nodes (24): dependencies, react, react-dom, stream-chat, stream-chat-react, @supabase/supabase-js, devDependencies, autoprefixer (+16 more)

### Community 14 - "alert-dialog.tsx"
Cohesion: 0.10
Nodes (16): AlertDialogAction(), AlertDialogCancel(), AlertDialogContent(), AlertDialogDescription(), AlertDialogFooter(), AlertDialogHeader(), AlertDialogOverlay(), AlertDialogTitle() (+8 more)

### Community 15 - "compilerOptions"
Cohesion: 0.08
Nodes (24): compilerOptions, allowImportingTsExtensions, baseUrl, erasableSyntaxOnly, jsx, lib, module, moduleDetection (+16 more)

### Community 16 - "client.ts"
Cohesion: 0.14
Nodes (6): NotificationsPage(), MyReviewsPage(), DeleteReviewButton(), createClient(), AppNotification, Review

### Community 17 - "ui.tsx"
Cohesion: 0.11
Nodes (18): ActivityCard(), ActivityRow(), Button(), ButtonProps, CategoryTile(), Footer(), HeaderProps, Icon() (+10 more)

### Community 18 - "command.tsx"
Cohesion: 0.12
Nodes (15): Command(), CommandDialog(), CommandGroup(), CommandInput(), CommandItem(), CommandList(), CommandSeparator(), CommandShortcut() (+7 more)

### Community 19 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection, moduleResolution, noEmit (+11 more)

### Community 20 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 21 - "components.json"
Cohesion: 0.11
Nodes (18): aliases, components, hooks, lib, ui, utils, iconLibrary, registries (+10 more)

### Community 22 - "App.tsx"
Cohesion: 0.14
Nodes (14): Button(), Calendar(), CalendarDayButton(), Input(), Label(), includedFeatures, ClaimBusinessPage(), venues (+6 more)

### Community 23 - "field.tsx"
Cohesion: 0.13
Nodes (16): ButtonGroup(), ButtonGroupSeparator(), ButtonGroupText(), buttonGroupVariants, Field(), FieldContent(), FieldDescription(), FieldError() (+8 more)

### Community 24 - "compilerOptions"
Cohesion: 0.11
Nodes (17): compilerOptions, allowJs, allowSyntheticDefaultImports, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, jsx, lib (+9 more)

### Community 25 - "data.ts"
Cohesion: 0.21
Nodes (13): AuthProvider(), AuthState, Ctx, ActivityDetail, ChildRecommendations, Activity, ActivitySession, Child (+5 more)

### Community 26 - "menubar.tsx"
Cohesion: 0.12
Nodes (11): Menubar(), MenubarCheckboxItem(), MenubarContent(), MenubarItem(), MenubarLabel(), MenubarRadioItem(), MenubarSeparator(), MenubarShortcut() (+3 more)

### Community 27 - "SettingsPage.tsx"
Cohesion: 0.16
Nodes (12): apiGet(), apiPost(), getChatClient(), Database, ProviderLocation, supabase, MessagesPage(), completion() (+4 more)

### Community 28 - "AuthProvider.tsx"
Cohesion: 0.13
Nodes (19): App(), RecoveryRedirect(), AuthProvider(), AuthState, Ctx, useAuth(), RequireAuth(), Provider (+11 more)

### Community 29 - "BookingsPage.tsx"
Cohesion: 0.12
Nodes (16): Checkbox(), Progress(), PortalLayout(), sidebarItems, ageLabel(), BookingsPage(), bookingsTabs, initials() (+8 more)

### Community 30 - "context-menu.tsx"
Cohesion: 0.12
Nodes (9): ContextMenuCheckboxItem(), ContextMenuContent(), ContextMenuItem(), ContextMenuLabel(), ContextMenuRadioItem(), ContextMenuSeparator(), ContextMenuShortcut(), ContextMenuSubContent() (+1 more)

### Community 31 - "dropdown-menu.tsx"
Cohesion: 0.12
Nodes (9): DropdownMenuCheckboxItem(), DropdownMenuContent(), DropdownMenuItem(), DropdownMenuLabel(), DropdownMenuRadioItem(), DropdownMenuSeparator(), DropdownMenuShortcut(), DropdownMenuSubContent() (+1 more)

### Community 32 - "carousel.tsx"
Cohesion: 0.20
Nodes (13): Carousel(), CarouselApi, CarouselContent(), CarouselContext, CarouselContextProps, CarouselItem(), CarouselNext(), CarouselOptions (+5 more)

### Community 33 - "BabyBrain Phase 1 — Backend Architecture"
Cohesion: 0.07
Nodes (26): 10. TypeScript Types, 11. Folder Structure (Next.js 15 app), 12. Implementation Roadmap (~4 weeks, one founder-engineer), 1. System Architecture Diagram, 2. Database ERD, 3–4. Database Schema & Migrations, 5. RLS Policies, 6. Authentication Architecture (+18 more)

### Community 34 - "input-group.tsx"
Cohesion: 0.24
Nodes (9): InputGroup(), InputGroupAddon(), inputGroupAddonVariants, InputGroupButton(), inputGroupButtonVariants, InputGroupInput(), InputGroupText(), InputGroupTextarea() (+1 more)

### Community 35 - "item.tsx"
Cohesion: 0.18
Nodes (12): Item(), ItemActions(), ItemContent(), ItemDescription(), ItemFooter(), ItemGroup(), ItemHeader(), ItemMedia() (+4 more)

### Community 36 - "validate.mjs"
Cohesion: 0.15
Nodes (11): admin, anon, clientA, clientB, dob, EXPECTED_TABLES, musicTop, noRls (+3 more)

### Community 37 - "BabyBrain.sg Component Rebuild Analysis"
Cohesion: 0.17
Nodes (11): Asset Policy, BabyBrain.sg Component Rebuild Analysis, Component Inventory, Corners, Shadows, And Borders, Grid Structure And Spacing, Interaction Notes, Layout Hierarchy, Palette (+3 more)

### Community 38 - "form.tsx"
Cohesion: 0.23
Nodes (10): FormControl(), FormDescription(), FormFieldContext, FormFieldContextValue, FormItem(), FormItemContext, FormItemContextValue, FormLabel() (+2 more)

### Community 39 - "crawl-vendors.mjs"
Cohesion: 0.24
Nodes (11): api(), crawlOne(), env, host(), out, prior, priorByName, runner() (+3 more)

### Community 40 - "BabyBrain — Setup Status & Remaining Steps"
Cohesion: 0.18
Nodes (10): 1. Google OAuth, 2. Auth URL configuration, 3. Resend domain + SMTP (required before real users), 4. Rotate keys before launch, Already done (verified working), Answering support chat, BabyBrain — Setup Status & Remaining Steps, Local dev (+2 more)

### Community 41 - "BabyBrain Phase 2 — Vendor/Provider Backend Architecture"
Cohesion: 0.18
Nodes (7): SelectContent(), SelectItem(), SelectLabel(), SelectScrollDownButton(), SelectScrollUpButton(), SelectSeparator(), SelectTrigger()

### Community 42 - "useActivities.ts"
Cohesion: 0.27
Nodes (10): ExplorePage(), MiniActivityGrid(), formatAgeRange(), SortOption, ActivityQuery, area(), LiveActivity, sgDate() (+2 more)

### Community 43 - "chart.tsx"
Cohesion: 0.25
Nodes (9): ChartConfig, ChartContainer(), ChartContext, ChartContextProps, ChartLegendContent(), ChartTooltipContent(), getPayloadConfigFromPayload(), THEMES (+1 more)

### Community 44 - "drawer.tsx"
Cohesion: 0.18
Nodes (6): DrawerContent(), DrawerDescription(), DrawerFooter(), DrawerHeader(), DrawerOverlay(), DrawerTitle()

### Community 45 - "api.ts"
Cohesion: 0.40
Nodes (5): ClassGroupChat(), EnquiryChat(), apiGet(), apiPost(), getChatClient()

### Community 46 - "ActivitiesPage.tsx"
Cohesion: 0.27
Nodes (8): Switch(), Activity, ActivityCategory, VendorCategory, ActivitiesPage(), ageLabel(), fmtDate(), tabs

### Community 47 - "middleware.ts"
Cohesion: 0.33
Nodes (7): allowedOrigins(), corsHeaders(), DEFAULT_ORIGINS, PROTECTED_PREFIXES, updateSession(), config, middleware()

### Community 48 - "enrich-gemini.mjs"
Cohesion: 0.31
Nodes (8): d, env, extract(), out, pick(), runner(), sleep(), targets

### Community 50 - "empty.tsx"
Cohesion: 0.29
Nodes (7): Empty(), EmptyContent(), EmptyDescription(), EmptyHeader(), EmptyMedia(), emptyMediaVariants, EmptyTitle()

### Community 52 - "validate-vendor.mjs"
Cohesion: 0.25
Nodes (5): admin, cols, sql, stamp, tables

### Community 53 - "BabyBrain Phase 2 — Vendor backend setup & API reference"
Cohesion: 0.29
Nodes (6): 1. Stripe setup (needed for billing/payouts), 2. GetStream — already wired, 3. Vendor API contract (for the frontend you built), 4. Automated emails (reuse Phase 1 Resend pipeline), 5. What's left (not blocking backend), BabyBrain Phase 2 — Vendor backend setup & API reference

### Community 54 - "tsconfig.json"
Cohesion: 0.29
Nodes (6): compilerOptions, baseUrl, paths, files, @/*, references

### Community 55 - "layout.tsx"
Cohesion: 0.40
Nodes (3): BRAND_COLORS, metadata, NavLinks()

### Community 56 - "input-otp.tsx"
Cohesion: 0.33
Nodes (4): input-otp, InputOTP(), InputOTPGroup(), InputOTPSlot()

### Community 57 - "enrich-regex.mjs"
Cohesion: 0.40
Nodes (4): d, grab(), out, uniq()

### Community 59 - "alert.tsx"
Cohesion: 0.50
Nodes (4): Alert(), AlertDescription(), AlertTitle(), alertVariants

### Community 60 - "seed.mjs"
Cohesion: 0.40
Nodes (3): ACTIVITIES, admin, catId

### Community 61 - "vercel.json"
Cohesion: 0.40
Nodes (4): buildCommand, framework, installCommand, $schema

### Community 63 - "React + TypeScript + Vite"
Cohesion: 0.50
Nodes (3): Expanding the ESLint configuration, React Compiler, React + TypeScript + Vite

## Knowledge Gaps
- **444 isolated node(s):** `AGE_OPTIONS`, `DISTANCE_OPTIONS`, `metadata`, `BRAND_COLORS`, `TIME_CHIPS` (+439 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `cn()` connect `cn` to `sidebar.tsx`, `utils.ts`, `alert-dialog.tsx`, `command.tsx`, `App.tsx`, `field.tsx`, `menubar.tsx`, `SettingsPage.tsx`, `AuthProvider.tsx`, `BookingsPage.tsx`, `context-menu.tsx`, `dropdown-menu.tsx`, `carousel.tsx`, `input-group.tsx`, `item.tsx`, `form.tsx`, `BabyBrain Phase 2 — Vendor/Provider Backend Architecture`, `chart.tsx`, `drawer.tsx`, `ActivitiesPage.tsx`, `breadcrumb.tsx`, `empty.tsx`, `DashboardPage.tsx`, `input-otp.tsx`, `alert.tsx`?**
  _High betweenness centrality (0.199) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `input-otp.tsx`, `sonner`, `devDependencies`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Why does `input-otp` connect `input-otp.tsx` to `dependencies`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **What connects `AGE_OPTIONS`, `DISTANCE_OPTIONS`, `metadata` to the rest of the system?**
  _444 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `cn` be split into smaller, more focused modules?**
  _Cohesion score 0.05010351966873706 - nodes in this community are weakly interconnected._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.04081632653061224 - nodes in this community are weakly interconnected._
- **Should `sidebar.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.05673758865248227 - nodes in this community are weakly interconnected._