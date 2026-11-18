# Design system and visual assets

FoodLoop uses a fresh-market identity: deep **emerald** actions, a lime **zest** accent, cool sage neutrals and forest-ink text, with forest-night hero panels on the public pages. All values are CSS variables defined in [apps/web/src/app/globals.css](../apps/web/src/app/globals.css) (`@theme` plus `:root` aliases), so changing a token re-themes every route, status badge, dialog, map and chart.

## Colour tokens

| Token | Value | Use |
|---|---|---|
| `--color-stone-50` (`--fl-bg`) | `#f5f8f6` | page background (with faint emerald and lime glows) |
| `--color-stone-100/200/300` | `#ebf0ed` / `#dbe3de` / `#c1ccc5` | surfaces, borders, skeletons |
| `--color-stone-500/600/700` | `#5c6a62` / `#47544d` / `#34403a` | secondary text (all at least 4.5:1 on the background) |
| `--color-stone-900` (`--fl-text`) | `#14201b` | text (forest ink) |
| `--color-stone-950` (`--fl-ink`) | `#0a1411` | header, hero panels, "ink" tiles |
| `--color-brand-600` (`--fl-primary`) | `#067858` | primary buttons (`.btn-primary`, soft gradient and glow), links; white on it is about 5.6:1 |
| `--color-brand-700` | `#065f47` | hover, link text on light |
| `--color-brand-50/100/200` | `#ecfbf4` / `#d2f5e5` / `#a5ead0` | selected states, soft panels |
| `--color-zest-300` (`--fl-accent`) | `#c9ee52` | active nav pill, role chip, highlights and focus ring on dark (always with dark text) |
| `--color-zest-50/100/700` | `#f7fde6` / `#edfac2` / `#546f0b` | waiting tints, row hover, text on tint |

Semantic states always carry a glyph and a text label as well as a colour: *done/verified/completed* = emerald; *in progress/reserved/in transit* = indigo-blue; *waiting/pending* = zest; *needs attention/delayed* = amber/orange; *failed/rejected* = red; *cancelled* = grey. Tailwind's `green`, `blue`, `sky` and `orange` scales are tuned in `@theme`. Map markers use emerald (pickup), forest ink (NGO), indigo (runner) and orange (urgent); the tile layer is softened with a CSS filter.

Typography: **Bricolage Grotesque** for headings and the wordmark, **Plus Jakarta Sans** for body text, loaded with `next/font/google` in `app/layout.tsx`. The fonts are downloaded at build time and served by the app itself, so the browser makes no request to Google. If they are unavailable the stacks fall back to Segoe UI / system sans.

## Interaction and motion

All motion is CSS (no animation library) and is switched off by `prefers-reduced-motion`.

- Page transition: `<main>` fades up (0.28 s) when a route mounts; dashboard card grids use `.stagger` (40 ms steps).
- Hover/pressed: `.lift` cards rise and gain a shadow, `.row-hover` rows tint, buttons scale to 0.97 when pressed, photos inside cards zoom slowly.
- `CountUp` (`components/ui.tsx`) shows the real value; it animates only when a later value differs from the previous one (for example a rescue completes while the impact page is open). An unchanged poll does nothing and the first value is shown as is.
- Skeleton loaders shimmer; empty, error and success notes fade in (`.fl-appear`).
- Mobile menu: animated open/close, closes on Escape (focus returns to the button), on a press outside the header, and when a link is chosen; closed links are not focusable.
- `ConfirmDialog` uses the native `<dialog>`: modal, focus trapped, Escape and backdrop click cancel. The NGO "Accept this food" confirmation uses it.
- `StageTrack` draws a rescue's progress from its real status on the board and on the rescue page; escalation waves are drawn as step chips on the board.

## Photos and logo

The FoodLoop logo (mark, wordmark and favicon) is original SVG artwork: [apps/web/public/brand/](../apps/web/public/brand/), [apps/web/src/app/icon.svg](../apps/web/src/app/icon.svg), `components/Logo.tsx`. Photographs are bundled in [apps/web/public/photos/](../apps/web/public/photos/) as resized JPEGs (nothing is loaded from another site). Metadata is in [apps/web/src/lib/photoCredits.ts](../apps/web/src/lib/photoCredits.ts) and shown at `/credits`.

| File | Title | Author | Licence | Source |
|---|---|---|---|---|
| `hero-handover.jpg` | Jimmy Panetta distributing food at the Food Bank for Monterey County 01.jpg | Creator:Jimmy Panetta | Public domain | [Commons](https://commons.wikimedia.org/wiki/File:Jimmy_Panetta_distributing_food_at_the_Food_Bank_for_Monterey_County_01.jpg) |
| `volunteers-serving.jpg` | Thanksgiving lunch at USO (5994609).jpg | U.S. Army USAG-V by Laura Kreider | Public domain | [Commons](https://commons.wikimedia.org/wiki/File:Thanksgiving_lunch_at_USO_(5994609).jpg) |
| `cooked-thali.jpg` | Malwani Chicken Thali.jpg | Shailesh V Nigawale | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:Malwani_Chicken_Thali.jpg) |
| `cooked-plate.jpg` | Darjeeling, India, Indian Thali meal.jpg | Vyacheslav Argenberg | CC BY 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:Darjeeling,_India,_Indian_Thali_meal.jpg) |
| `bakery-loaves.jpg` | Loaves of Bread (Unsplash).jpg | Clark Young clark1 | CC0 | [Commons](https://commons.wikimedia.org/wiki/File:Loaves_of_Bread_(Unsplash).jpg) |
| `bakery-trays.jpg` | US Navy 090716-N-6720T-017 Culinary Specialist Seaman Samantha Garza butters loaves of fresh baked bread in the bakeshop aboard the aircraft carrier USS George Washington (CVN 73).jpg | U.S. Navy photo by Mass Communication Specialist Seaman Adam | Public domain | [Commons](https://commons.wikimedia.org/wiki/File:US_Navy_090716-N-6720T-017_Culinary_Specialist_Seaman_Samantha_Garza_butters_loaves_of_fresh_baked_bread_in_the_bakeshop_aboard_the_aircraft_carrier_USS_George_Washington_(CVN_73).jpg) |
| `produce-market.jpg` | Outdoor market fruit and vegetable stall Market Place Romford London 01.jpg | Acabashi | CC BY-SA 4.0 | [Commons](https://commons.wikimedia.org/wiki/File:Outdoor_market_fruit_and_vegetable_stall_Market_Place_Romford_London_01.jpg) |
| `packaged-tiffin.jpg` | First tiffin lunch.jpg | bandita | CC BY-SA 2.0 | [Commons](https://commons.wikimedia.org/wiki/File:First_tiffin_lunch.jpg) |
| `volunteer-handoff.jpg` | DHS Secretary Alejandro Mayorkas Volunteers at Capital Area Food Bank (52519257457).jpg | DHSgov | Public domain | [Commons](https://commons.wikimedia.org/wiki/File:DHS_Secretary_Alejandro_Mayorkas_Volunteers_at_Capital_Area_Food_Bank_(52519257457).jpg) |
| `provider-kitchen.jpg` | Michael (Unsplash).jpg | Toa Heftiba heftiba | CC0 | [Commons](https://commons.wikimedia.org/wiki/File:Michael_(Unsplash).jpg) |

Only CC0, public-domain, CC BY and CC BY-SA files are used. To add one: drop an optimised JPEG into `apps/web/public/photos/`, add its entry to `photoCredits.ts` and use the `Photo` component. The only remote requests the UI can make are OpenStreetMap map tiles on rescue maps (existing behaviour; the page still works and lists positions as text if they fail).
