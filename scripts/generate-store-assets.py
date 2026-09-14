#!/usr/bin/env python3
"""Compose Chrome Web Store images from existing UI screenshots."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / "docs" / "screenshots"
ASSETS = ROOT / "assets"
OUT = ROOT / "docs" / "store"

BG = (255, 247, 237, 255)
CARD = (255, 250, 245, 255)
INK = (28, 25, 23, 255)
MUTED = (87, 83, 78, 255)
ACCENT = (154, 52, 18, 255)
SHADOW = (28, 25, 23, 48)


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]
    for path in candidates:
        if not Path(path).exists():
            continue
        try:
            return ImageFont.truetype(path, size=size, index=0)
        except OSError:
            continue
    return ImageFont.load_default()


def rounded_shadow(image: Image.Image, radius: int = 18, pad: int = 18) -> Image.Image:
    w, h = image.size
    canvas = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((pad + 4, pad + 8, pad + w + 4, pad + h + 10), radius=radius, fill=SHADOW)
    shadow = shadow.filter(ImageFilter.GaussianBlur(10))
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=radius, fill=255)
    rounded = Image.new("RGBA", image.size, (0, 0, 0, 0))
    rounded.paste(image.convert("RGBA"), (0, 0), mask)
    canvas = Image.alpha_composite(canvas, shadow)
    canvas.paste(rounded, (pad, pad), rounded)
    return canvas


def fit_into(image: Image.Image, max_w: int, max_h: int) -> Image.Image:
    clone = image.convert("RGBA")
    clone.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    return clone


def store_canvas(title: str, source: Path, max_w: int, max_h: int, scale_min: float | None = None) -> Image.Image:
    canvas = Image.new("RGBA", (1280, 800), BG)
    draw = ImageDraw.Draw(canvas)
    title_font = load_font(36, bold=True)
    caption_font = load_font(20)
    draw.text((64, 48), title, font=title_font, fill=INK)
    draw.text((64, 100), "真实扩展界面 · 非官方辅助", font=caption_font, fill=MUTED)

    shot = Image.open(source)
    fitted = fit_into(shot, max_w, max_h)
    if scale_min and fitted.width < shot.width * scale_min:
        pass
    framed = rounded_shadow(fitted)
    x = (1280 - framed.width) // 2
    y = 148 + (800 - 148 - framed.height) // 2
    canvas.alpha_composite(framed, (x, max(148, y)))
    return canvas


def write_promo() -> None:
    canvas = Image.new("RGBA", (440, 280), BG)
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((16, 16, 423, 263), radius=24, fill=CARD)
    icon = Image.open(ASSETS / "1point3acres-helper-icon-128.png").convert("RGBA").resize((88, 88), Image.Resampling.LANCZOS)
    canvas.paste(icon, (40, 56), icon)
    title_font = load_font(26, bold=True)
    body_font = load_font(18)
    draw.text((148, 68), "一亩三分地每日助手", font=title_font, fill=INK)
    draw.text((148, 112), "一键签到 & 答题", font=body_font, fill=ACCENT)
    draw.text((148, 148), "本机辅助 · 非官方", font=body_font, fill=MUTED)
    canvas.save(OUT / "promo-440x280.png", "PNG")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    Image.open(ASSETS / "1point3acres-helper-icon-128.png").convert("RGBA").save(OUT / "icon-128.png", "PNG")
    write_promo()
    shots = [
        ("screenshot-popup.png", "弹窗 · 一键签到 & 答题", SHOTS / "popup.png", 560, 520),
        ("screenshot-popup-completed.png", "弹窗 · 今日已全部完成", SHOTS / "popup-completed.png", 560, 520),
        ("screenshot-answer.png", "每日答题页 · 页面工具栏", SHOTS / "answer.png", 1120, 560),
        ("screenshot-checkin.png", "每日签到页 · 页面工具栏", SHOTS / "checkin.png", 1120, 560),
    ]
    for name, title, source, max_w, max_h in shots:
        store_canvas(title, source, max_w, max_h).save(OUT / name, "PNG")
        image = Image.open(OUT / name)
        if image.size != (1280, 800):
            raise SystemExit(f"{name} is {image.size}, expected 1280x800")
    promo = Image.open(OUT / "promo-440x280.png")
    if promo.size != (440, 280):
        raise SystemExit(f"promo is {promo.size}, expected 440x280")
    print(f"Wrote store assets to {OUT}")


if __name__ == "__main__":
    main()
