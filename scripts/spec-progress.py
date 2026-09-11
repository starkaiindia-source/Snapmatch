#!/usr/bin/env python3
"""
Reports collection progress for the device spec database.

Reads data/specs/_worklist.json (every model in the catalogue, in the
canonical processing order) and every record written under data/specs/<brand>/,
then writes data/specs/_progress.json and prints a summary.

Progress is derived from what is actually on disk, so it can never drift
from reality the way a hand-maintained tracker would.

    python scripts/spec-progress.py            # all brands
    python scripts/spec-progress.py apple      # one brand
"""
import json, os, sys, glob, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPECS = os.path.join(ROOT, "data", "specs")
NF = "Not Found in Source 1/Source 2"
NPA = "Not Published by Manufacturer"

# fields that decide how complete a record is
CORE = [
    ("identity", "officialModelNumbers"), ("identity", "releaseDate"),
    ("identity", "formFactor"),
    ("body", "heightMm"), ("body", "weightG"), ("body", "widthMm"),
    ("display", "size"), ("display", "resolution"), ("display", "pixelDensity"),
    ("platform", "chipset"), ("platform", "officialProcessor"),
    ("battery", "type"), ("battery", "batteryLife"),
    ("camera", "mainCamera"), ("camera", "frontCamera"), ("camera", "videoRecording"),
    ("connectivity", "wifiStandard"), ("connectivity", "bluetoothVersion"),
    ("sim", "simType"),
]
# the fields that make the record useful to a parts finder
REPAIR = ["displayModelNo", "displayAssemblyPartNo", "batteryModelNo",
          "batteryPartNo", "backGlassPartNo", "chargingBoardPartNo"]


def missing(v):
    return v in (None, "", NF, NPA) or v == [NF] or v == []


def score(rec):
    have = sum(1 for sec, key in CORE if not missing(rec.get(sec, {}).get(key)))
    parts = sum(1 for k in REPAIR if not missing(rec.get("serviceParts", {}).get(k)))
    priced = sum(1 for v in rec.get("variants", [])
                 if not missing(v.get("launchPrice")) or not missing(v.get("currentPrice")))
    return have, parts, priced


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    with open(os.path.join(SPECS, "_worklist.json"), encoding="utf-8") as f:
        work = json.load(f)

    by_brand = {}
    for row in work:
        by_brand.setdefault(row["brandId"], {"brand": row["brand"], "total": 0, "ids": []})
        by_brand[row["brandId"]]["total"] += 1
        by_brand[row["brandId"]]["ids"].append(row["id"])

    out, totals = {}, {"total": 0, "collected": 0, "verified": 0, "crossChecked": 0,
                       "partial": 0, "withRepairParts": 0, "withPrices": 0}
    for bid, info in sorted(by_brand.items()):
        if only and bid != only:
            continue
        files = [p for p in glob.glob(os.path.join(SPECS, bid, "*.json")) if not os.path.basename(p).startswith("_")]
        stats = {"brand": info["brand"], "total": info["total"], "collected": len(files),
                 "OFFICIAL SOURCE VERIFIED": 0, "CROSS-CHECKED": 0, "TECHSPECS VERIFIED": 0, "PARTIAL": 0,
                 "CONFLICT": 0, "withRepairParts": 0, "withPrices": 0, "coreFieldAvg": 0.0}
        core_sum = 0
        for p in files:
            with open(p, encoding="utf-8") as f:
                rec = json.load(f)
            st = rec.get("verification", {}).get("status", "PARTIAL")
            stats[st] = stats.get(st, 0) + 1
            have, parts, priced = score(rec)
            core_sum += have
            if parts:
                stats["withRepairParts"] += 1
            if priced:
                stats["withPrices"] += 1
        if files:
            stats["coreFieldAvg"] = round(core_sum / len(files), 1)
        stats["remaining"] = stats["total"] - stats["collected"]
        out[bid] = stats
        totals["total"] += stats["total"]
        totals["collected"] += stats["collected"]
        totals["verified"] += stats["OFFICIAL SOURCE VERIFIED"]
        totals["crossChecked"] += stats["CROSS-CHECKED"]
        totals["partial"] += stats["PARTIAL"]
        totals["withRepairParts"] += stats["withRepairParts"]
        totals["withPrices"] += stats["withPrices"]

    # next model to work on, in canonical order
    nxt = None
    for row in work:
        if not os.path.exists(os.path.join(SPECS, row["brandId"], row["id"] + ".json")):
            nxt = row
            break

    payload = {"generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
               "totals": totals, "brands": out,
               "nextModel": nxt and {"id": nxt["id"], "brand": nxt["brand"], "url": nxt["gsmarenaUrl"]}}
    with open(os.path.join(SPECS, "_progress.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1, ensure_ascii=False)

    w = max(len(s["brand"]) for s in out.values()) if out else 8
    print(f"{'BRAND':<{w}}  {'DONE':>5} {'TOTAL':>6} {'XCHK':>5} {'PART':>5} {'PARTS#':>7} {'PRICE':>6} {'CORE/19':>8}")
    for bid, s in out.items():
        print(f"{s['brand']:<{w}}  {s['collected']:>5} {s['total']:>6} "
              f"{s['CROSS-CHECKED']:>5} {s['PARTIAL']:>5} {s['withRepairParts']:>7} "
              f"{s['withPrices']:>6} {s['coreFieldAvg']:>8}")
    print(f"\nTOTAL collected {totals['collected']} / {totals['total']}"
          f"  ({100.0 * totals['collected'] / totals['total']:.1f}%)")
    if nxt:
        print(f"NEXT: {nxt['brand']} - {nxt['id']}")


if __name__ == "__main__":
    main()
