#!/usr/bin/env python3
"""
Mobile Parts Finder - scripts/build-category-cutouts.py
-----------------------------------------------------------------------------
Makes a transparent-background copy of each category master, for the phone's
category rail where the cards sit on the green hero and a white rectangle
around every part looks like a sticker.

    python scripts/build-category-cutouts.py            # write cutouts
    python scripts/build-category-cutouts.py --dry      # report only

    out: assets/categories/cutout/<id>.png

THE ORIGINALS ARE NOT TOUCHED. The desktop tiles and the group cards keep
using them, where a white card is deliberate and reads correctly. This only
adds a second rendering of the same artwork.

WHY A FLOOD FILL AND NOT A THRESHOLD

  "Every pixel brighter than X becomes transparent" also eats the parts. A
  tempered-glass sheet is nearly white; so are the printed panel on a battery
  and the highlights down a phone's edge. Punching those out leaves holes in
  the middle of the product.

  So the fill starts from the four EDGES and spreads only through pixels that
  are near-white AND connected to the border. White enclosed by the product
  never gets reached, because the product is in the way. That is the whole
  difference between removing a background and removing a colour.

  The alpha is then feathered by one pixel, so the cut edge is not a staircase
  against the green, and pixels near the boundary keep a little of their
  coverage rather than snapping to on or off.

SAFETY CHECK. Every cutout is compared against the part's own bounding box
from the manifest: if the fill has eaten into it, the file is rejected and the
category keeps the original. A silently hollowed-out product is worse than a
white background.
"""

import argparse
import json
import os
import sys
from collections import deque

try:
    from PIL import Image, ImageFilter
except ImportError:
    sys.exit("\n  Pillow is required:  pip install Pillow\n")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets", "categories")
OUT = os.path.join(ASSETS, "cutout")
MANIFEST = os.path.join(ASSETS, "manifest.json")

# A pixel counts as background when every channel is at least this bright.
# Deliberately strict: the glass sheet on the screen-guard master runs into the
# 230s, and a looser bar reaches it through the thin light rim around the phone.
WHITE = 238


def cut(path):
    """Edge-connected near-white -> transparent. Returns (image, filled_px)."""
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()

    def is_bg(x, y):
        r, g, b, a = px[x, y]
        return a > 0 and r >= WHITE and g >= WHITE and b >= WHITE

    seen = bytearray(w * h)
    q = deque()

    def push(x, y):
        i = y * w + x
        if not seen[i] and is_bg(x, y):
            seen[i] = 1
            q.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    while q:
        x, y = q.popleft()
        if x > 0: push(x - 1, y)
        if x < w - 1: push(x + 1, y)
        if y > 0: push(x, y - 1)
        if y < h - 1: push(x, y + 1)

    # Build the alpha channel from the mask, then soften it by a pixel so the
    # cut edge does not stair-step against the green behind it.
    alpha = Image.new("L", (w, h), 255)
    ap = alpha.load()
    filled = 0
    for y in range(h):
        row = y * w
        for x in range(w):
            if seen[row + x]:
                ap[x, y] = 0
                filled += 1
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))

    im.putalpha(alpha)
    return im, filled


def opaque_box(im, thresh=32):
    """Bounding box of pixels that survived, to compare against the manifest."""
    a = im.getchannel("A")
    bbox = a.point(lambda v: 255 if v > thresh else 0).getbbox()
    return bbox


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    with open(MANIFEST, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)

    os.makedirs(OUT, exist_ok=True)
    written, skipped = [], []
    print()

    for cat_id, entry in manifest["categories"].items():
        src = os.path.join(ROOT, entry["file"])
        if not os.path.exists(src):
            print("  !  missing %s" % entry["file"])
            continue

        im, filled = cut(src)
        w, h = im.size
        box = opaque_box(im)
        want = entry.get("subject")

        # The part must survive intact. Its measured box is the reference; a
        # cutout whose remaining pixels no longer cover it has eaten product.
        ok = True
        if want and box:
            ok = (box[0] <= want["x"] + 2 and box[1] <= want["y"] + 2 and
                  box[2] >= want["x"] + want["w"] - 2 and
                  box[3] >= want["y"] + want["h"] - 2)

        pct = round(100.0 * filled / (w * h))
        if not ok:
            skipped.append(cat_id)
            print("  !  %-15s cutout would clip the part - keeping the original" % cat_id)
            continue

        print("  %-15s %d%% of the canvas removed, part intact" % (cat_id, pct))
        written.append(cat_id)
        if not args.dry:
            im.save(os.path.join(OUT, cat_id + ".png"), "PNG", optimize=True)

    if args.dry:
        print("\n  --dry: nothing written.\n")
        return

    # Record which categories actually have one. The path is derivable, but
    # WHICH ids succeeded is not — a category whose cutout was rejected must
    # keep the original, and only this list knows that.
    mapping = os.path.join(ROOT, "src", "data", "category-assets.js")
    with open(mapping, "r", encoding="utf-8") as fh:
        src = fh.read()
    line = "  var CUTOUTS = %s;" % json.dumps(sorted(written))
    import re
    if re.search(r"^\s*var CUTOUTS = .*;$", src, re.M):
        src = re.sub(r"^\s*var CUTOUTS = .*;$", line, src, count=1, flags=re.M)
        with open(mapping, "w", encoding="utf-8") as fh:
            fh.write(src)
        print("\n  wrote  src/data/category-assets.js  (CUTOUTS)")
    else:
        print("\n  !  no CUTOUTS line in category-assets.js - add one:\n" + line)

    print("  wrote %d cutout(s) -> assets/categories/cutout/" % len(written))
    if skipped:
        print("  kept original for: " + ", ".join(skipped))
    print()


if __name__ == "__main__":
    main()
