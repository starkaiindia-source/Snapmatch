#!/usr/bin/env python3
"""
Mobile Parts Finder - scripts/build-category-focus.py
-----------------------------------------------------------------------------
Measures where the PART actually is inside each category asset, and writes the
numbers the tile CSS needs to make that part fill the card.

    python scripts/build-category-focus.py            # measure and write
    python scripts/build-category-focus.py --dry      # report only

WHY THIS EXISTS

  The category masters are square canvases with the part standing in the
  middle of a lot of white:

      back-cover      subject fills  45% of the canvas width
      combo-display                  42%
      middle-frame                   47%
      battery                        61%
      screen-guards                  70%
      cc-board                       84%

  `object-fit: contain` fits the CANVAS, not the part. So a back cover renders
  at 45% of the card no matter how large the card is - which is why making the
  tile taller on its own changes nothing, and why the parts looked small.

  This script finds each part's bounding box and precomputes three CSS numbers
  that place and scale the image so the PART - not its canvas - fits the tile.
  Aspect ratio is preserved exactly (the <img> is given a width and an auto
  height, so it cannot be distorted) and nothing is cropped: the overhang is
  the asset's own white margin, clipped against a white chip.

  The assets themselves are NOT touched. The same PNG the site already serves,
  including the copy in Firebase Storage, is what gets rendered - so this
  needs no re-upload and cannot drift from the bucket.

THE MATH

  Box W wide, aspect A = H/W, fixed in CSS. Inset F leaves a margin so the
  part never touches the edge. Canvas cw x ch, subject bw x bh at (bx, by).

      k    = min(F/bw, F*A/bh)      scale, in box-widths per canvas pixel
      --iw = cw * k                 image width, as a fraction of box width
      --il = 0.5 - k*(bx + bw/2)    left,  as a fraction of box width
      --it = 0.5 - k*(by + bh/2)/A  top,   as a fraction of box height

  A and F are recorded in the output. Change the tile's aspect ratio in CSS
  and you must re-run this with a matching --aspect, or the parts will sit
  off-centre - the generated header says which values were used.
"""

import argparse
import json
import os
import re
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("\n  Pillow is required:  pip install Pillow\n")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets", "categories")
MANIFEST = os.path.join(ASSETS, "manifest.json")
MAPPING = os.path.join(ROOT, "src", "data", "category-assets.js")

# Anything this close to white is background, not part of the product. Kept
# generous: a soft drop shadow under a part is background too, and treating a
# 2% grey halo as subject would put the box back around the whole canvas.
WHITE = 244


def subject_box(path):
    """Bounding box of the non-white, non-transparent pixels, or None."""
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 16:
                continue
            if r > WHITE and g > WHITE and b > WHITE:
                continue
            if x < minx: minx = x
            if y < miny: miny = y
            if x > maxx: maxx = x
            if y > maxy: maxy = y
    if maxx < 0:
        return None
    return (minx, miny, maxx - minx + 1, maxy - miny + 1, w, h)


def focus_for(box, aspect, inset):
    bx, by, bw, bh, cw, ch = box
    k = min(inset / bw, inset * aspect / bh)
    return {
        "iw": round(cw * k, 4),
        "il": round(0.5 - k * (bx + bw / 2.0), 4),
        "it": round(0.5 - k * (by + bh / 2.0) / aspect, 4),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--aspect", type=float, default=4.0 / 3.0,
                    help="tile height / width; must match the CSS aspect-ratio")
    ap.add_argument("--inset", type=float, default=0.88,
                    help="fraction of the box the part fills on its long side")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    with open(MANIFEST, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)

    rows = {}
    print()
    for cat_id, entry in manifest["categories"].items():
        path = os.path.join(ROOT, entry["file"])
        if not os.path.exists(path):
            print("  !  missing %s" % entry["file"])
            continue
        box = subject_box(path)
        if not box:
            print("  !  %s is blank" % cat_id)
            continue
        bx, by, bw, bh, cw, ch = box
        focus = focus_for(box, args.aspect, args.inset)
        rows[cat_id] = focus
        entry["subject"] = {"x": bx, "y": by, "w": bw, "h": bh}
        entry["focus"] = focus
        print("  %-15s canvas %dx%d  part %dx%d (%d%% of width)  ->  iw %.3f  il %+.3f  it %+.3f"
              % (cat_id, cw, ch, bw, bh, round(100.0 * bw / cw),
                 focus["iw"], focus["il"], focus["it"]))

    manifest["focus"] = {"aspect": round(args.aspect, 4), "inset": args.inset}

    if args.dry:
        print("\n  --dry: nothing written.\n")
        return

    with open(MANIFEST, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")

    # Write each focus triple into its row in category-assets.js, leaving the
    # storage and bundled URLs - which the uploader owns - untouched.
    with open(MAPPING, "r", encoding="utf-8") as fh:
        src = fh.read()

    written = 0
    for cat_id, focus in rows.items():
        line = '      focus: { iw: %s, il: %s, it: %s }' % (
            focus["iw"], focus["il"], focus["it"])
        # replace an existing focus line, else append after the bundled line
        pat_existing = re.compile(
            r"(^\s*'%s':\s*\{[^}]*?)\n\s*focus:\s*\{[^}]*\}" % re.escape(cat_id),
            re.M | re.S)
        if pat_existing.search(src):
            src = pat_existing.sub(lambda m: m.group(1) + "\n" + line, src, count=1)
        else:
            pat_bundled = re.compile(
                r"(^\s*'%s':\s*\{[^}]*?bundled:\s*\"[^\"]*\")" % re.escape(cat_id),
                re.M | re.S)
            if not pat_bundled.search(src):
                print("  !  no row for %s in category-assets.js" % cat_id)
                continue
            src = pat_bundled.sub(lambda m: m.group(1) + ",\n" + line, src, count=1)
        written += 1

    with open(MAPPING, "w", encoding="utf-8") as fh:
        fh.write(src)

    print("\n  aspect %.4f   inset %.2f" % (args.aspect, args.inset))
    print("  wrote  assets/categories/manifest.json")
    print("  wrote  src/data/category-assets.js  (%d categories)\n" % written)


if __name__ == "__main__":
    main()
