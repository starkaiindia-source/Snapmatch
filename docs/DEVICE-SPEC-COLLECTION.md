# Device Spec Collection — master data for the ProGlide Device Finder

The catalogue already holds **4,933 models across 22 brands**, but each model
carries only a name, a release date, a size, a battery capacity and a GSMArena
link. This pipeline enriches every one of those models to a full A-to-R spec
record that a parts-matching database can rely on.

## Layout

```
data/specs/_worklist.json         every model, in canonical processing order
data/specs/_progress.json         generated; never hand-edited
data/specs/_input/<brand>-bNN.json  compact researched values, one batch per file
data/specs/<brand>/<model-id>.json  the expanded full record
scripts/spec-build.py             expands _input batches into full records
scripts/spec-progress.py          reports progress from what is on disk
```

## Processing order

Brands run in strict alphabetical order:

Apple, Asus, Coolpad, Google, HMD, Honor, Huawei, Infinix, itel, Lava, Lenovo,
Motorola, Nokia, Nothing, OnePlus, Oppo, Realme, Samsung, Tecno, Vivo, Xiaomi, ZTE

Within a brand: phones first (oldest to newest), then tablets and other device
types. `spec-progress.py` prints the next uncollected model, so work resumes
from exactly where it stopped — no duplicated effort after an interruption.

## Record shape

One JSON file per model, sectioned to match the collection spec:

| Section | Key | Covers |
|---|---|---|
| A | `identity` | names, model numbers, internal identifier, series, dates, status |
| B | `design` | form factor, materials, dimensions, weight, IP rating, screen shape |
| C | `display` | panel, size, resolution, ppi, refresh, brightness, protection |
| D | `platform` | chipset, fabrication, CPU, GPU, regional silicon |
| E | `variants[]` | one entry per RAM + storage combination, each with its own prices |
| F | `colors[]` | official colours only |
| G/H | `pricing` | launch prices per variant; `approxMarket`; `amazonIn`; check date |
| I | `battery` | capacity, chemistry, removability, charging, rated Wh |
| J | `camera` | rear, front, video |
| K | `connectivity` | bands, Wi-Fi, Bluetooth, NFC, positioning, USB, UWB |
| L | `sim` | SIM configuration, eSIM |
| M | `audio` | speakers, jack, codecs |
| N/O | `sensors[]`, `security` | sensors, fingerprint type and location, face unlock |
| P | `software` | OS at launch, UI, maximum OS, update policy |
| Q | `regionVariants[]` | separate record only when the hardware actually differs |
| R | `serviceParts` | display assembly, battery, back glass, charging board, flex … |

## Rules that are never bypassed

1. **Nothing is invented.** A value that could not be verified is `"Not Found"`.
   A value that is known to exist but is not published is
   `"Not Publicly Available"`. Sources that disagree produce `"Conflict"` plus
   both values in `verification.notes`.
2. **Part numbers are never generated.** `serviceParts` defaults to
   `"Not Publicly Available"` and is only overwritten from a real service or
   repair source.
3. **GSMArena's "Price" row is not a launch price.** It is an approximate
   current street price, so it goes in `pricing.approxMarket` with a date, never
   in `pricing.launch`.
4. **One source is not verification.** A record backed only by GSMArena is
   `PARTIAL`. It becomes `CROSS-CHECKED` when a second independent source
   confirms the critical fields, and `VERIFIED` when the manufacturer or an
   official service document is one of them.
5. **Variants stay separate.** Each RAM/storage combination is its own entry
   with its own prices; they are never merged or copied across.
6. **Regional variants** get their own model record only when the hardware
   differs in a way that affects parts (e.g. `apple-iphone-4-cdma`).

## Normalisation

`8 GB` not `8GB`/`8Gb` · storage in GB/TB · battery in mAh · display in inches ·
dimensions in mm · weight in g · dates ISO `YYYY-MM-DD` (or `YYYY-MM` when only
the month is published) · prices keep their original currency.

## Running it

```bash
python scripts/spec-build.py data/specs/_input/apple-b03.json apple
python scripts/spec-progress.py apple
```

## Known blockers

- **Amazon.in current prices** — `amazon.in` returns HTTP 503 to server-side
  fetches, so live retail prices cannot be collected without a paid data API.
  `pricing.amazonIn` stays `"Not Found"` until one is provisioned. See the
  options discussed with the project owner.
- **Service part numbers** are sourceable for Apple (Apple's `661-xxxxx` service
  pack numbers and battery `A`-numbers appear in repair-parts catalogues) but are
  largely unpublished for most Android brands, where they will stay
  `"Not Publicly Available"`.
