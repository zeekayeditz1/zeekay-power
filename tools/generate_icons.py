from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "branding" / "zeekay-logo-mark-source.png"


def load_mark() -> Image.Image:
    mark = Image.open(SOURCE).convert("RGBA")
    alpha_box = mark.getchannel("A").getbbox()
    if not alpha_box:
        raise ValueError(f"Logo source has no visible pixels: {SOURCE}")
    return mark.crop(alpha_box)


def fit_mark(canvas_size: int, width_ratio: float) -> Image.Image:
    mark = load_mark()
    target_width = max(1, round(canvas_size * width_ratio))
    target_height = max(1, round(target_width * mark.height / mark.width))
    return mark.resize((target_width, target_height), Image.Resampling.LANCZOS)


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

    inset = int(width * 0.018)
    radius = int(width * (0.22 if not maskable else 0.04))
    mask = Image.new("L", (width, width), 0)
    ImageDraw.Draw(mask).rounded_rectangle((inset, inset, width - inset, width - inset), radius=radius, fill=255)
    image.putalpha(mask)

    mark = fit_mark(width, 0.66 if maskable else 0.86)
    glow_layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    mark_x = (width - mark.width) // 2
    mark_y = (width - mark.height) // 2
    glow_mask = mark.getchannel("A").filter(ImageFilter.GaussianBlur(width * .022))
    glow_color = Image.new("RGBA", mark.size, (31, 183, 220, 105))
    glow_color.putalpha(glow_mask.point(lambda a: round(a * 0.4)))
    glow_layer.alpha_composite(glow_color, (mark_x, mark_y + round(width * .012)))
    image.alpha_composite(glow_layer)
    image.alpha_composite(mark, (mark_x, mark_y))

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
    fit_mark(256, 0.94).save(web_dir / "zeekay-logo-mark.png", optimize=True)

    res_dir = ROOT / "android" / "app" / "src" / "main" / "res"
    densities = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for density, size in densities.items():
        target = res_dir / f"mipmap-{density}"
        target.mkdir(parents=True, exist_ok=True)
        render_legacy_launcher(size, False).save(target / "ic_launcher.png", optimize=True)
        render_legacy_launcher(size, True).save(target / "ic_launcher_round.png", optimize=True)

    drawable = res_dir / "drawable-nodpi"
    drawable.mkdir(parents=True, exist_ok=True)
    foreground = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
    adaptive_mark = fit_mark(432, 0.68)
    foreground.alpha_composite(adaptive_mark, ((432 - adaptive_mark.width) // 2, (432 - adaptive_mark.height) // 2))
    foreground.save(drawable / "ic_launcher_foreground.png", optimize=True)
    monochrome = Image.new("RGBA", foreground.size, (255, 255, 255, 0))
    monochrome.putalpha(foreground.getchannel("A"))
    monochrome.save(drawable / "ic_launcher_monochrome.png", optimize=True)


if __name__ == "__main__":
    save_icons()
