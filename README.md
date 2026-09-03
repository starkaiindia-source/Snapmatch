# Mobile Parts Finder (UI prototype)

Responsive web app for mobile shop owners, accessories
sellers, technicians and spare-parts businesses: search a phone model, get the
compatibility group, master model, part code and every other device that takes
the same part.

**This build is frontend only.** No backend, no database, no Firebase, no
Supabase, no API calls, no authentication provider, no payment gateway. All data
is generated in the browser from a fixed seed; session and subscription state
live in `localStorage`.

---

## Run it

```bash
node server.js
```

Then open <http://localhost:4321>. No install step, no dependencies, no build
required for development — `index.html` loads the sources directly.

To produce the single-file bundles:

```bash
node build.js
```

- `dist/mobile-parts-finder.html` — standalone page, open it directly in any browser
- `dist/mobile-parts-finder.artifact.html` — same page as a body fragment, for publishing

---

## Files

```
index.html              dev shell — links the CSS and the five scripts
assets/styles.css       design tokens, reset, type scale, shell, search
assets/components.css   feature components (plates, sheets, plans, states)
src/data/mock-data.js   sample database generator  ← REPLACE THIS
src/data/api.js         repository layer + mock session  ← REWIRE THIS
src/ui/icons.js         inline icon set + the Mobile Parts Finder mark
src/ui/product-art.js   category product renders + brand logo mapping
src/ui/components.js    reusable render functions
src/app.js              shell, hash router, pages, interactions
build.js                inlines everything into dist/
server.js               20-line static server for local preview
```

---

## Connecting a real backend later

Every screen talks to the app **only** through `SM.api`. No component reads
`SM.db` for anything except id lookups. To go live, rewrite the method bodies in
`src/data/api.js` as `fetch()` calls that resolve the same shapes:

| Method | Suggested endpoint |
| --- | --- |
| `stats()` | `GET /stats` |
| `listBrands()` | `GET /brands` |
| `listModels({brandId,q,page,pageSize,sort})` | `GET /models` |
| `getModel(id)` | `GET /models/:id` |
| `suggestModels(q,limit)` | `GET /models/suggest` |
| `listGroups({q,brandId,categoryId,sort,page,pageSize})` | `GET /groups` |
| `getGroup(groupId)` | `GET /groups/:id` |
| `findMatches({modelId,categoryId})` | `GET /match` |
| `categoryAvailability(modelId)` | `GET /models/:id/categories` |

Every method already returns a Promise and resolves after a simulated delay, so
the loading skeletons and empty states in the UI are real code paths, not
mock-ups. Swapping in a network call changes nothing else.

`SM.session` (sign in, subscribe, cancel, access state) is the second seam — it
maps onto real auth and a real payment provider without touching any screen.

### Entity shapes

```
Brand   { id, name, code, color, color2, modelCount }

Model   { id, brandId, brand, modelName, fullName, releaseDate, releaseYear,
          displaySize, screenResolution, screenRatio, screenType, refreshRate,
          ppi, protection, height, width, thickness, weight, sim }

Group   { groupId, groupNumber, serialNumber, partCode, categoryId,
          masterModelId, compatibleDeviceIds[], compatibleCount, createdOn }
```

### Auto-generated identifiers

Generated in `mock-data.js`, never entered by hand:

- **Group number** — `GRP-001`, sequential across all groups
- **Serial number** — `MPF-SN-000001`, sequential
- **Part code** — `TG-SAM-A55-001` = category code · brand code · model slug ·
  per-category sequence. Verified unique across all 170 groups.

---

## Sample data in this build

288 models · 13 brands · 170 compatibility groups · 8 part categories ·
3,463 device fitments.

Group sizes deliberately span the full range so the UI is proven against all of
them: 13 model-specific groups of 1, most in the 2–30 range, and ten groups over
100 including one universal spare-parts group of **268 devices**. That largest
group renders in 60-device chunks with in-group search.

The brands and models are realistic sample data for design review. They are not
a production parts database.

---

## Access states

All Mobile Models is free for everyone. Device Finder matching is the paid
feature. Four states are implemented and switchable from the sliders icon in the
header or the panel at the bottom of the Account page:

| State | Device Finder |
| --- | --- |
| Guest | browse groups; match result and full fitment list locked |
| Free user | same as guest, with an account |
| Active subscriber | everything unlocked |
| Expired | locked again, with a renewal prompt |

Plans are ₹99/month and ₹799/year. Choosing one only flips local state — **no
payment gateway is connected and nothing is charged.**

---

## Deployment

Static hosting on Vercel, redeployed automatically on every push to `main`.

`vercel.json` is the important file. It declares the three static roots and
nothing else:

```json
{ "version": 2, "builds": [ { "src": "index.html", "use": "@vercel/static" }, ... ] }
```

Declaring `builds` switches Vercel's framework auto-detection **off**. That
matters: the local preview server used to live at the repo root as
`server.js`, Vercel detected it as a Node entrypoint and routed the entire
site through it as a serverless function. Only `index.html` was bundled into
that function, so every stylesheet and script 404'd and the site rendered
blank. The preview server now lives at `scripts/dev-server.js`, where nothing
detects it.

Three things to know before editing the deployment config:

- **`vercel.json` allows no unknown keys.** Its schema
  (<https://openapi.vercel.sh/vercel.json>) sets `"additionalProperties": false`,
  so a `"//"` comment key makes the whole file invalid. Vercel then fails the
  build and leaves the previous deployment in production — the site does not
  change, and nothing about the live response says why. Keep notes here, not
  in the JSON.
- **`buildCommand: null` does not mean "no build".** The schema defines `null`
  as *automatically detected*, which is the detection this setup exists to
  avoid. `builds` is what turns detection off.
- **`.vercelignore` follows `.gitignore` matching**, so a bare `data/` also
  excludes `src/data/`. Anchor every pattern with a leading slash.

`.vercelignore` keeps the generated dataset off the site as well: `data/build/`
holds the part numbers and fitment lists the subscription pays for.
`assets/search-index.json` stays deployed on purpose — it is the free
catalogue and carries no paid fields.

## Design notes

- **Palette** — bench ink `#0A1512`, signal teal `#0F766E → #10D0A8` (primary),
  kapton amber `#FF8A3D → #FFB347` (premium/CTA), cool paper `#F2F5F4`. The
  eight category colours are data encoding, not decoration.
- **Type** — Bricolage Grotesque (display), Manrope (UI), JetBrains Mono (part
  codes and serials).
- **Group cards are printed part labels**: mono ID strip, dashed tear line,
  category stripe, master model set large.
- Light and dark themes are both defined at token level and cover all three
  viewer states (explicit light, explicit dark, and OS preference).
- Mobile gets a bottom tab bar, sticky filter bar and a bottom-sheet overlay;
  desktop gets a top nav and a centred modal.

### Category renders and brand logos

`src/ui/product-art.js` is the single visual mapping. Category product renders
are drawn as vector cutouts and mounted once as an SVG sprite, so each card
costs only a `<use>` reference. The same render appears in the left Part
Category tiles, the model's category grid, the filter sheet, and every
compatibility group card.

To swap in photographed renders or real brand logo files later, register them —
no component changes needed:

    SM.art.registerCategory('battery', 'assets/parts/battery.png');
    SM.art.registerBrand('samsung', 'assets/brands/samsung.svg');

Both fall back gracefully: an unregistered path, or an image that fails to
load, reverts to the drawn render / monogram chip.

**No trademarked brand artwork is redrawn or approximated here.** The brand
panel keeps its monogram chips until real licensed logo files are registered
through `SM.art.registerBrand`.

### Group browsing layout

Above **1180px** the whole app runs full-bleed and the browse view fills the
viewport — the page itself does not scroll:

```
app header (full width, one 66px row)
  logo · nav icons · search · counters · filter/theme/profile
┌────────────┬────────────────────────┬──────────┐
│ Part       │ Compatibility groups   │ Brands   │
│ categories │ (scrolls on its own)   │          │
│ 2-up tiles │ sticky toolbar on top  │ list     │
│ sticky     │                        │ sticky   │
└────────────┴────────────────────────┴──────────┘
```

Both side panels scroll internally when their content is taller than the
viewport; the centre column is the only region that scrolls with content, and
there is never a second page-level scrollbar. Card columns use
`repeat(auto-fill, minmax(262px, 1fr))` so they respond to the real column
width rather than the viewport width.

Recent searches are not a permanent row: focusing an empty search box opens
them in the dropdown (clock icons, most recent first, de-duplicated); typing
replaces them with live matches from the model database; clearing brings them
back; blur/Escape/selection closes the panel.

The search is rendered twice — once in the header (`#qh`, desktop) and once in
the hero (`#q`, mobile/tablet). Only one is ever visible, both write to
`state.finder.query`, and each owns its own suggestion slot. Recent searches are
kept in `localStorage` (`mpf.recent.v1`), seeded with five common models
so the row is never empty.

Below 1180px the **same markup** collapses back to the original single-column
page: the header search hides and the hero search takes over, the side panels
move into the filter bottom sheet, the horizontal category chip row and the
mobile filter toolbar return, and the full hero comes back. Mobile and tablet
are unchanged.

Selecting a model switches to the focused match view, which stays a normal
single-column scrolling page.
