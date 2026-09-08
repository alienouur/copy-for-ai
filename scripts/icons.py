"""Generate extension icons: rounded indigo square with a white clipboard + spark."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "static" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BASE = 512


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, BASE - 1, BASE - 1), radius=110, fill=(79, 70, 229, 255))

    # clipboard body
    d.rounded_rectangle((128, 132, 352, 420), radius=36, fill=(255, 255, 255, 255))
    d.rounded_rectangle((196, 104, 284, 164), radius=22, fill=(255, 255, 255, 255))
    d.rounded_rectangle((212, 118, 268, 150), radius=14, fill=(79, 70, 229, 255))
    # text lines
    for y in (216, 268, 320):
        d.rounded_rectangle((168, y, 300 if y != 320 else 250, y + 22), radius=11, fill=(199, 210, 254, 255))

    # spark (4-point star) bottom-right
    cx, cy, r, r2 = 392, 372, 88, 26
    pts = [
        (cx, cy - r), (cx + r2, cy - r2), (cx + r, cy), (cx + r2, cy + r2),
        (cx, cy + r), (cx - r2, cy + r2), (cx - r, cy), (cx - r2, cy - r2),
    ]
    d.polygon(pts, fill=(250, 204, 21, 255))

    return img.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    draw_icon(s).save(OUT / f"icon{s}.png")
draw_icon(512).save(OUT.parent.parent / "site" / "icon512.png") if (OUT.parent.parent / "site").exists() else None
print("icons written to", OUT)
