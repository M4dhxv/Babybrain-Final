#!/usr/bin/env python3
"""
Hide a face in a photo before it goes on the public site.

    python3 scripts/hide-face.py in.jpg out.jpg --at 0.36,0.30,0.13,0.11
    python3 scripts/hide-face.py in.jpg out.jpg --at 0.36,0.30,0.13,0.11 --mode heart

`--at` is cx,cy,rx,ry as fractions of the image's width/height, so the same
numbers work whatever resolution the original is.

Modes:
  blur     Gaussian blur inside a soft-edged ellipse (default). Reads as a
           deliberate privacy choice rather than a graphic.
  pixelate Mosaic inside the same ellipse.
  heart    Brand-pink heart covering the face, as in the design mock.

The feathered mask matters: a hard-edged blur looks like a mistake, and a
blur that's too weak can sometimes be reversed.
"""
import argparse
import sys

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    sys.exit("Pillow is required:  python3 -m pip install Pillow")


def parse_at(value):
    try:
        cx, cy, rx, ry = (float(p) for p in value.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("--at must be cx,cy,rx,ry as fractions, e.g. 0.36,0.30,0.13,0.11")
    if not all(0 <= v <= 1 for v in (cx, cy)) or not all(0 < v <= 1 for v in (rx, ry)):
        raise argparse.ArgumentTypeError("--at values must be between 0 and 1")
    return cx, cy, rx, ry


def ellipse_box(size, at):
    w, h = size
    cx, cy, rx, ry = at
    return (
        int((cx - rx) * w),
        int((cy - ry) * h),
        int((cx + rx) * w),
        int((cy + ry) * h),
    )


def feathered_mask(size, box, feather):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).ellipse(box, fill=255)
    return mask.filter(ImageFilter.GaussianBlur(feather))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("dest")
    ap.add_argument("--at", type=parse_at, required=True, help="cx,cy,rx,ry as fractions of width/height")
    ap.add_argument("--mode", choices=("blur", "pixelate", "heart"), default="blur")
    ap.add_argument("--strength", type=float, default=1.0, help="multiplier on the blur radius / mosaic size")
    ap.add_argument("--quality", type=int, default=88)
    args = ap.parse_args()

    img = Image.open(args.src).convert("RGB")
    box = ellipse_box(img.size, args.at)
    face_w = max(1, box[2] - box[0])

    if args.mode == "heart":
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(overlay)
        cx = (box[0] + box[2]) / 2
        cy = (box[1] + box[3]) / 2
        r = face_w * 0.72
        pink = (250, 93, 147, 255)
        # Two lobes plus a triangle. The triangle's top edge sits on the lobe
        # centre line and spans their full width, so the union has no gap —
        # a cover with holes in it would defeat the point.
        d.ellipse([cx - r, cy - r * 0.75, cx, cy + r * 0.25], fill=pink)
        d.ellipse([cx, cy - r * 0.75, cx + r, cy + r * 0.25], fill=pink)
        d.polygon([(cx - r, cy - r * 0.25), (cx + r, cy - r * 0.25), (cx, cy + r * 1.15)], fill=pink)
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    else:
        if args.mode == "blur":
            radius = max(8, face_w * 0.28 * args.strength)
            hidden = img.filter(ImageFilter.GaussianBlur(radius))
        else:
            blocks = max(4, int(14 / max(args.strength, 0.1)))
            small = img.resize((blocks, max(1, int(blocks * img.height / img.width))), Image.NEAREST)
            hidden = small.resize(img.size, Image.NEAREST)
        img.paste(hidden, (0, 0), feathered_mask(img.size, box, feather=max(4, face_w * 0.09)))

    kwargs = {"quality": args.quality, "optimize": True} if args.dest.lower().endswith((".jpg", ".jpeg")) else {"optimize": True}
    img.save(args.dest, **kwargs)
    print(f"{args.src} → {args.dest}  ({img.width}×{img.height}, {args.mode})")


if __name__ == "__main__":
    main()
