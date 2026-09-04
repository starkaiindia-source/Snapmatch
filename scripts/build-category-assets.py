"""
Mobile Parts Finder - scripts/build-category-assets.py
==============================================================================
Prepares the official category logos for the web, from the master files.

    python scripts/build-category-assets.py --src "C:/Users/stark/Downloads"

Reads one master image per category, writes a web-sized copy into
assets/categories/, and records what it produced in
assets/categories/manifest.json.

WHAT IT DOES TO THE IMAGE, AND WHAT IT DOES NOT

    It resizes. That is all. No crop, no recolour, no redraw, no added
    background, no substitution - the logo that comes out is the logo that went
    in, at a size a browser can use.

    The masters are around 1,254 px and a megabyte each. The site shows them
    between 32 px and 58 px. Serving the masters would be roughly 7 MB of
    category icons on the first paint of the finder, for detail no screen can
    resolve. 256 px covers every use on the site at 4x device pixel ratio.

FILE NAMES ARE THE CATEGORY IDS THE APP ALREADY USES

    battery, cc-board, combo-display, middle-frame, screen-guards, back-cover -
    the same ids that already select a category, route to it and count its
    groups. No taxonomy is added, renamed or changed to hang a picture on it.

SOURCES

    Looked for as <category-id>.png in --src. Failing that, the download names
    the masters arrived under are accepted once, so the first run works without
    renaming anything by hand. Rename them and that fallback stops mattering.
==============================================================================
"""
import os, sys, json, hashlib

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required:  pip install Pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "categories")

args = [a for a in sys.argv[1:] if not a.startswith("--")]
SRC = args[0] if args else r"C:\Users\stark\Downloads"

WEB_PX = 256          # every on-site use is <= 58 px; 256 covers 4x DPR

# The six part categories, in the order the app lists them.
CATEGORIES = [
    ("screen-guards",  "Screen Guards"),
    ("back-cover",     "Back Cover"),
    ("combo-display",  "Combo/Display"),
    ("middle-frame",   "Middle Frame"),
    ("cc-board",       "CC Board"),
    ("battery",        "Battery"),
]

# The names the masters were delivered under. Used only when <id>.png is absent,
# so the first run needs no manual renaming; identified by opening each one.
DELIVERED_AS = {
    "screen-guards": "57615.png",
    "back-cover":    "5743.png",
    "combo-display": "57592.png",
    "middle-frame":  "5791.png",
    "cc-board":      "5850.png",
    "battery":       "5742.png",
}


def find_master(cat_id):
    """<id>.png if it exists, otherwise the delivered filename."""
    named = os.path.join(SRC, cat_id + ".png")
    if os.path.exists(named):
        return named, True
    legacy = os.path.join(SRC, DELIVERED_AS.get(cat_id, ""))
    if legacy and os.path.exists(legacy):
        return legacy, False
    return None, False


def web_copy(src_path, dest_path):
    """Resize to fit WEB_PX, preserving aspect ratio and every pixel's colour.

    thumbnail() fits inside the box rather than filling it, so a non-square
    master - the CC board is 1402x1122 - keeps its shape instead of being
    squashed into a square or cropped to one.
    """
    im = Image.open(src_path)
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if "A" in im.mode else "RGB")
    im.thumbnail((WEB_PX, WEB_PX), Image.LANCZOS)
    im.save(dest_path, "PNG", optimize=True)
    return im.size


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {"generatedAt": None, "widthPx": WEB_PX, "categories": {}}
    rows, missing = [], []

    for cat_id, label in CATEGORIES:
        master, renamed = find_master(cat_id)
        if not master:
            missing.append((cat_id, label))
            continue
        dest = os.path.join(OUT, cat_id + ".png")
        w, h = web_copy(master, dest)
        manifest["categories"][cat_id] = {
            "label": label,
            "file": "assets/categories/" + cat_id + ".png",
            "width": w, "height": h,
            "sha256": sha(dest),
            "master": os.path.basename(master),
        }
        rows.append((cat_id, label, os.path.basename(master), w, h,
                     os.path.getsize(master) / 1024.0,
                     os.path.getsize(dest) / 1024.0, renamed))

    import datetime
    manifest["generatedAt"] = datetime.datetime.utcnow().isoformat() + "Z"
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    w = sys.stdout.write
    w("\n  Mobile Parts Finder - category logos\n")
    w("  " + "-" * 70 + "\n")
    w("  %-15s %-22s %9s %10s %9s\n" % ("category", "master", "size", "master KB", "web KB"))
    total_src = total_out = 0
    for cid, label, master, ww, hh, ksrc, kout, renamed in rows:
        w("  %-15s %-22s %5dx%-4d %8.0f %9.1f%s\n" %
          (cid, master, ww, hh, ksrc, kout, "" if renamed else "  *"))
        total_src += ksrc
        total_out += kout
    w("  " + "-" * 70 + "\n")
    w("  %d of %d categories   %.1f MB of masters -> %.0f KB served\n" %
      (len(rows), len(CATEGORIES), total_src / 1024.0, total_out))
    if any(not r[7] for r in rows):
        w("  * read from its delivered filename; rename to <category-id>.png in\n"
          "    the source folder and this run becomes reproducible without the map\n")
    if missing:
        w("\n  NO MASTER FOUND, and nothing was invented for them:\n")
        for cid, label in missing:
            w("    %-15s %s\n" % (cid, label))
        w("    Put <id>.png in the source folder and run again.\n")
    w("\n  manifest -> assets/categories/manifest.json\n")
    w("  next     -> node scripts/upload-category-assets.js --project mobilepartsfinder\n\n")


if __name__ == "__main__":
    main()
