"""
Mobile Parts Finder - scripts/build-icons.py
==============================================================================
Renders the site's icon set from the OFFICIAL logo, the one SM.logoMark() draws
in src/ui/icons.js. Same geometry, same gradients, same colours - so the tab
icon, the home-screen icon and the share card are the mark already in the
header, not a second logo that drifts away from it.

    python scripts/build-icons.py

Writes
    assets/brand/logo.svg          the mark on its own, for <link rel=icon> and
                                   anywhere an SVG is wanted
    favicon.ico                    16 + 32 + 48, at the site root
    assets/brand/icon-16.png       browser tab
    assets/brand/icon-32.png       browser tab, retina
    assets/brand/icon-180.png      apple-touch-icon
    assets/brand/icon-192.png      Android / PWA
    assets/brand/icon-512.png      Android / PWA, splash
    assets/brand/icon-512-maskable.png   Android adaptive, with safe padding
    assets/brand/og-image.png      1200x630 social card

WHY IT IS DRAWN AND NOT TRACED
    The mark is a rounded square, a circle, a small rounded rectangle and two
    strokes. Drawing those directly at each target size gives an exact result
    at 16 pixels, where a downscaled 512 render turns the lens ring to mush.
    Everything is drawn at 8x and reduced with a Lanczos filter, which is what
    makes the small sizes clean.

    The one thing that would be wrong is inventing a second logo. Every value
    below is copied from SM.logoMark(); change it there and change it here.
==============================================================================
"""
import os, sys, math

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow is required:  pip install Pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = os.path.join(ROOT, "assets", "brand")

SS = 8                      # supersample factor

# ---- the mark, exactly as SM.logoMark() draws it (viewBox 0 0 48 48) -------
TEAL_0, TEAL_55, TEAL_100 = (0x0F, 0x76, 0x6E), (0x12, 0xA0, 0x8C), (0x10, 0xD0, 0xA8)
AMBER_0, AMBER_100 = (0xFF, 0x8A, 0x3D), (0xFF, 0xC4, 0x6B)
NOTCH = (0x8A, 0x4A, 0x12)

VB = 48.0
PLATE_RADIUS = 14.0
LENS_C, LENS_R = (20.5, 20.5), 11.6
LENS_RING_W = 3.2
PART_XYWH, PART_R = (16.6, 13.2, 7.8, 14.6), 2.2
NOTCH_Y, NOTCH_X0, NOTCH_X1, NOTCH_W = 15.4, 18.5, 22.5, 1.1
HANDLE_A, HANDLE_B, HANDLE_W = (29.4, 29.4), (37.0, 37.0), 4.6


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


GRAD_STEPS = 256      # a linear ramp needs no more; the rest is interpolation


def diagonal_gradient(size, stops, reverse=False):
    """A linear gradient along the diagonal, which is what x1,y1 -> x2,y2 means
    for both gradients in the mark.

    Built once at 256x256 and resized. A per-pixel Python loop at the
    supersampled size is 16 million iterations and takes minutes; a linear ramp
    is smooth by definition, so scaling a small one up is indistinguishable and
    effectively instant."""
    n = GRAD_STEPS

    # One row of the ramp, then smeared diagonally by rotating a vertical ramp.
    ramp = Image.new("RGB", (n, 1))
    px = ramp.load()
    for x in range(n):
        t = x / float(n - 1)
        for i in range(len(stops) - 1):
            p0, c0 = stops[i]
            p1, c1 = stops[i + 1]
            if t <= p1 or i == len(stops) - 2:
                span = (p1 - p0) or 1.0
                px[x, 0] = lerp(c0, c1, min(1.0, max(0.0, (t - p0) / span)))
                break

    # Stretch the ramp across a square, then shear it into a diagonal by
    # compositing it against a rotated copy of itself.
    horiz = ramp.resize((n, n))
    vert = horiz.rotate(90 if not reverse else -90)
    img = Image.blend(horiz, vert, 0.5)
    return img.resize((size, size), Image.BILINEAR)


def draw_mark(size, pad_ratio=0.0):
    """The mark at `size` px. pad_ratio insets it, for the maskable icon whose
    outer 10% may be cropped to a circle by the launcher."""
    S = size * SS
    inset = int(S * pad_ratio)
    inner = S - inset * 2
    k = inner / VB                      # viewBox units -> supersampled px

    def P(v):                           # scalar
        return v * k

    def XY(x, y):                       # point
        return (inset + x * k, inset + y * k)

    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # --- plate: rounded square filled with the teal diagonal gradient -------
    plate_mask = Image.new("L", (inner, inner), 0)
    ImageDraw.Draw(plate_mask).rounded_rectangle(
        [0, 0, inner - 1, inner - 1], radius=P(PLATE_RADIUS), fill=255)
    plate = diagonal_gradient(inner, [(0.0, TEAL_0), (0.55, TEAL_55), (1.0, TEAL_100)])
    canvas.paste(plate, (inset, inset), plate_mask)

    d = ImageDraw.Draw(canvas, "RGBA")

    # --- lens glass: white at 18% ------------------------------------------
    cx, cy = XY(*LENS_C)
    r = P(LENS_R)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 46))

    # --- the part being found: amber rounded rect --------------------------
    px_, py_, pw, ph = PART_XYWH
    x0, y0 = XY(px_, py_)
    part_w, part_h = int(P(pw)), int(P(ph))
    part = diagonal_gradient(max(part_w, part_h), [(0.0, AMBER_0), (1.0, AMBER_100)],
                             reverse=True).resize((part_w, part_h))
    part_mask = Image.new("L", (part_w, part_h), 0)
    ImageDraw.Draw(part_mask).rounded_rectangle(
        [0, 0, part_w - 1, part_h - 1], radius=P(PART_R), fill=255)
    canvas.paste(part, (int(x0), int(y0)), part_mask)

    # --- the notch line across the part ------------------------------------
    d.line([XY(NOTCH_X0, NOTCH_Y), XY(NOTCH_X1, NOTCH_Y)],
           fill=NOTCH + (140,), width=max(1, int(P(NOTCH_W))))

    # --- lens ring, then the handle ----------------------------------------
    d.ellipse([cx - r, cy - r, cx + r, cy + r],
              outline=(255, 255, 255, 255), width=max(1, int(P(LENS_RING_W))))
    d.line([XY(*HANDLE_A), XY(*HANDLE_B)],
           fill=(255, 255, 255, 255), width=max(1, int(P(HANDLE_W))))
    # round cap, which a plain line does not give
    hr = P(HANDLE_W) / 2.0
    for pt in (XY(*HANDLE_A), XY(*HANDLE_B)):
        d.ellipse([pt[0] - hr, pt[1] - hr, pt[0] + hr, pt[1] + hr],
                  fill=(255, 255, 255, 255))

    return canvas.resize((size, size), Image.LANCZOS)


LOGO_SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="512" height="512" role="img" aria-label="Mobile Parts Finder">
  <title>Mobile Parts Finder</title>
  <defs>
    <linearGradient id="mpfPlate" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0F766E"/>
      <stop offset="55%" stop-color="#12A08C"/>
      <stop offset="100%" stop-color="#10D0A8"/>
    </linearGradient>
    <linearGradient id="mpfPart" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0%" stop-color="#FF8A3D"/>
      <stop offset="100%" stop-color="#FFC46B"/>
    </linearGradient>
  </defs>
  <rect width="48" height="48" rx="14" fill="url(#mpfPlate)"/>
  <circle cx="20.5" cy="20.5" r="11.6" fill="#fff" fill-opacity=".18"/>
  <rect x="16.6" y="13.2" width="7.8" height="14.6" rx="2.2" fill="url(#mpfPart)"/>
  <path d="M18.5 15.4h4" stroke="#8A4A12" stroke-opacity=".55" stroke-width="1.1" stroke-linecap="round"/>
  <circle cx="20.5" cy="20.5" r="11.6" fill="none" stroke="#fff" stroke-width="3.2"/>
  <path d="M29.4 29.4 37 37" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/>
</svg>
'''


def og_card():
    """1200x630 share card: the mark on the brand teal, with the wordmark.

    Text is drawn with the default bitmap font scaled up rather than a font file
    the repo does not ship - it is a logo lockup, not body copy, and a missing
    font file would fail the build on someone else's machine."""
    W, H = 1200, 630
    card = diagonal_gradient(max(W, H), [(0.0, (0x08, 0x1C, 0x1A)),
                                         (0.6, (0x0D, 0x3B, 0x36)),
                                         (1.0, (0x0F, 0x76, 0x6E))]).resize((W, H))
    card = card.convert("RGBA")
    mark = draw_mark(260)
    card.paste(mark, (110, (H - 260) // 2), mark)

    d = ImageDraw.Draw(card)
    # Wordmark, drawn as scaled bitmap text so no font file is required.
    def word(text, x, y, scale, fill):
        tmp = Image.new("RGBA", (len(text) * 6 + 4, 11), (0, 0, 0, 0))
        ImageDraw.Draw(tmp).text((0, 0), text, fill=fill)
        tmp = tmp.resize((tmp.width * scale, tmp.height * scale), Image.LANCZOS)
        card.paste(tmp, (x, y), tmp)

    word("MOBILE PARTS FINDER", 420, 250, 7, (255, 255, 255, 255))
    word("Spare-part compatibility for mobile shops", 420, 330, 4, (170, 240, 225, 255))
    return card.convert("RGB")


def main():
    os.makedirs(BRAND, exist_ok=True)

    with open(os.path.join(BRAND, "logo.svg"), "w", encoding="utf8") as f:
        f.write(LOGO_SVG)
    with open(os.path.join(ROOT, "favicon.svg"), "w", encoding="utf8") as f:
        f.write(LOGO_SVG)

    written = ["assets/brand/logo.svg", "favicon.svg"]

    for size in (16, 32, 180, 192, 512):
        img = draw_mark(size)
        rel = "assets/brand/icon-%d.png" % size
        img.save(os.path.join(ROOT, rel))
        written.append(rel)

    maskable = draw_mark(512, pad_ratio=0.10)
    maskable.save(os.path.join(BRAND, "icon-512-maskable.png"))
    written.append("assets/brand/icon-512-maskable.png")

    ico = draw_mark(64)
    ico.save(os.path.join(ROOT, "favicon.ico"),
             sizes=[(16, 16), (32, 32), (48, 48)])
    written.append("favicon.ico")

    og_card().save(os.path.join(BRAND, "og-image.png"), quality=92)
    written.append("assets/brand/og-image.png")

    print("\n  Mobile Parts Finder - icons")
    print("  " + "-" * 52)
    for rel in written:
        p = os.path.join(ROOT, rel)
        print("  %-40s %6.1f KB" % (rel, os.path.getsize(p) / 1024.0))
    print("\n  drawn from SM.logoMark() in src/ui/icons.js - one logo, one source\n")


if __name__ == "__main__":
    main()
