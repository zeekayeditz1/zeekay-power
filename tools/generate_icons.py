from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]


def render_icon(size: int, maskable: bool = False) -> Image.Image:
    scale = 4
    width = size * scale
    image = Image.new("RGB", (width, width), "#05070c")
    pixels = image.load()
    for y in range(width):
        for x in range(width):
            nx = x / width
            ny = y / width
            glow = max(0.0, 1.0 - ((nx - 0.26) ** 2 + (ny - 0.16) ** 2) ** 0.5 / 0.85)
            pixels[x, y] = (
                int(5 + 13 * glow),
                int(7 + 31 * glow),
                int(12 + 48 * glow),
            )

    draw = ImageDraw.Draw(image, "RGBA")
    inset = int(width * 0.018)
    radius = int(width * (0.22 if not maskable else 0.04))
    mask = Image.new("L", (width, width), 0)
    ImageDraw.Draw(mask).rounded_rectangle((inset, inset, width - inset, width - inset), radius=radius, fill=255)
    image.putalpha(mask)

    center = width / 2
    draw = ImageDraw.Draw(image, "RGBA")
    draw.ellipse((center - width * .33, center - width * .33, center + width * .33, center + width * .33),
                 fill=(55, 245, 181, 12), outline=(57, 184, 255, 55), width=max(2, width // 240))
    draw.ellipse((center - width * .43, center - width * .43, center + width * .43, center + width * .43),
                 outline=(55, 245, 181, 35), width=max(2, width // 300))

    factor = 0.78 if maskable else 1.0
    points = [(0.56, 0.16), (0.28, 0.56), (0.47, 0.56), (0.43, 0.84), (0.72, 0.40), (0.53, 0.40)]
    points = [
        (center + (px * width - center) * factor, center + (py * width - center) * factor)
        for px, py in points
    ]

    glow_layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ImageDraw.Draw(glow_layer).polygon(points, fill=(55, 245, 181, 190))
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(width * .035))
    image.alpha_composite(glow_layer)

    draw = ImageDraw.Draw(image, "RGBA")
    draw.polygon(points, fill=(55, 245, 181, 255))
    highlight = [(x - width * .008, y - width * .006) for x, y in points[:3]]
    draw.line(highlight, fill=(140, 255, 222, 210), width=max(2, width // 150), joint="curve")

    image = image.resize((size, size), Image.Resampling.LANCZOS)
    background = Image.new("RGB", image.size, "#05070c")
    background.paste(image, mask=image.getchannel("A"))
    return background


def render_legacy_launcher(size: int, round_icon: bool) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner_size = max(1, round(size * 0.82))
    inner = render_icon(inner_size).convert("RGBA")
    mask = Image.new("L", (inner_size, inner_size), 0)
    mask_draw = ImageDraw.Draw(mask)
    if round_icon:
        mask_draw.ellipse((0, 0, inner_size - 1, inner_size - 1), fill=255)
    else:
        mask_draw.rounded_rectangle(
            (0, 0, inner_size - 1, inner_size - 1),
            radius=max(1, round(inner_size * 0.22)),
            fill=255,
        )
    inner.putalpha(mask)
    offset = (size - inner_size) // 2
    canvas.alpha_composite(inner, (offset, offset))
    return canvas


def save_icons() -> None:
    web_dir = ROOT / "api" / "public" / "icons"
    web_dir.mkdir(parents=True, exist_ok=True)
    render_icon(192).save(web_dir / "icon-192.png", optimize=True)
    render_icon(512).save(web_dir / "icon-512.png", optimize=True)
    render_icon(512, maskable=True).save(web_dir / "icon-maskable-512.png", optimize=True)

    res_dir = ROOT / "android" / "app" / "src" / "main" / "res"
    densities = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for density, size in densities.items():
        target = res_dir / f"mipmap-{density}"
        target.mkdir(parents=True, exist_ok=True)
        render_legacy_launcher(size, False).save(target / "ic_launcher.png", optimize=True)
        render_legacy_launcher(size, True).save(target / "ic_launcher_round.png", optimize=True)


if __name__ == "__main__":
    save_icons()
