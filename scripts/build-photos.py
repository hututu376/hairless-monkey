"""把原始照片处理成站点用图。

用法：
    python scripts/build-photos.py                       # 默认读项目旁边的 ../photo
    python scripts/build-photos.py --src "D:/照片/无毛猴"

输出：
    public/media/gallery/*.jpg      相册图（长边 1600）
    public/media/hero.jpg           首屏图（长边 1400）
    public/media/side.jpg           内文配图（长边 1200）
    public/assets/data/curated.json 相册清单（含尺寸与低清占位图）
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import statistics
import sys
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps, ImageStat

ROOT = Path(__file__).resolve().parent.parent
# 项目在 E:\我的网站\无毛猴\web，照片在 E:\我的网站\无毛猴\photo
DEFAULT_SRC = ROOT.parent / "photo"
FALLBACK_SRC = Path(r"E:\我的网站\无毛猴\photo")

SUPPORTED = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}

# 首屏与内文配图人工指定；留空则按下面的启发式自动挑选。
# 这两张原本就是 3:4，放进 3:4 / 4:5 的取景框里几乎不裁切。
HERO_FILE = "3ce24eb3b7a23d1443ab2cbd67a657f3.jpg"
SIDE_FILE = "bc33cb8da94288e6defba5b92dabf06f.jpg"

GALLERY_EDGE = 1600
HERO_EDGE = 1400
SIDE_EDGE = 1200
QUALITY = 80


def load_image(path: Path) -> Image.Image:
    image = Image.open(path)
    image = ImageOps.exif_transpose(image)
    if image.mode in ("RGBA", "LA", "P"):
        background = Image.new("RGB", image.size, (255, 255, 255))
        rgba = image.convert("RGBA")
        background.paste(rgba, mask=rgba.split()[-1])
        return background
    return image.convert("RGB")


def resize(image: Image.Image, max_edge: int) -> Image.Image:
    if max(image.size) <= max_edge:
        return image.copy()
    copy = image.copy()
    copy.thumbnail((max_edge, max_edge), Image.LANCZOS)
    return copy


def save_jpeg(image: Image.Image, target: Path, quality: int = QUALITY) -> int:
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, "JPEG", quality=quality, optimize=True, progressive=True)
    return target.stat().st_size


def lqip_data_uri(image: Image.Image, width: int = 20) -> str:
    small = image.copy()
    ratio = width / small.width
    small = small.resize((width, max(1, round(small.height * ratio))), Image.LANCZOS)
    small = small.filter(ImageFilter.GaussianBlur(0.6))
    buffer = io.BytesIO()
    small.save(buffer, "JPEG", quality=38, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def stats(image: Image.Image) -> dict:
    gray = image.convert("L")
    thumb = gray.copy()
    thumb.thumbnail((320, 320), Image.LANCZOS)
    stat = ImageStat.Stat(thumb)
    mean = stat.mean[0]
    contrast = stat.stddev[0]

    hsv = image.convert("HSV")
    hsv.thumbnail((160, 160), Image.LANCZOS)
    saturation = ImageStat.Stat(hsv).mean[1]

    edges = thumb.filter(ImageFilter.FIND_EDGES)
    center = edges.crop(
        (
            int(edges.width * 0.2),
            int(edges.height * 0.2),
            int(edges.width * 0.8),
            int(edges.height * 0.8),
        )
    )
    detail = ImageStat.Stat(center).mean[0]

    return {
        "mean": mean,
        "contrast": contrast,
        "saturation": saturation,
        "detail": detail,
    }


def pick(names: list[str], table: dict, ratio: float) -> str:
    """挑一张亮度和清晰度都不错、比例最接近目标的照片。"""
    def score(name: str) -> float:
        item = table[name]
        brightness = 1.0 if 80 <= item["mean"] <= 195 else 0.45
        saturation = min(item["saturation"] / 60, 1.4)
        ratio_fit = max(0.0, 1 - abs(item["ratio"] - ratio) * 1.6)
        return (
            item["contrast"] * 0.9
            + item["detail"] * 0.8
            + saturation * 6
            + ratio_fit * 26
        ) * brightness

    return max(names, key=score)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", type=Path, default=DEFAULT_SRC)
    parser.add_argument("--hero", default=HERO_FILE)
    parser.add_argument("--side", default=SIDE_FILE)
    args = parser.parse_args()

    if args.src == DEFAULT_SRC and not args.src.is_dir() and FALLBACK_SRC.is_dir():
        args.src = FALLBACK_SRC

    if not args.src.is_dir():
        print(f"找不到照片目录：{args.src}", file=sys.stderr)
        return 1

    files = sorted(
        path for path in args.src.iterdir() if path.is_file() and path.suffix.lower() in SUPPORTED
    )
    if not files:
        print(f"{args.src} 里没有可用图片", file=sys.stderr)
        return 1

    gallery_dir = ROOT / "public" / "media" / "gallery"
    data_dir = ROOT / "public" / "assets" / "data"
    gallery_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    table: dict[str, dict] = {}
    images: dict[str, Image.Image] = {}

    for path in files:
        try:
            image = load_image(path)
        except Exception as error:  # noqa: BLE001 - 单张失败不影响整体
            print(f"跳过 {path.name}：{error}", file=sys.stderr)
            continue
        result = stats(image)
        result["ratio"] = image.width / image.height
        result["size"] = image.size
        table[path.name] = result
        images[path.name] = image

    if not table:
        print("没有可处理的图片", file=sys.stderr)
        return 1

    names = list(table)
    print(f"{'文件':<40}{'尺寸':>12}{'亮度':>8}{'对比':>8}{'饱和':>8}{'细节':>8}")
    for name in sorted(names, key=lambda n: -table[n]["detail"]):
        item = table[name]
        size = f"{item['size'][0]}x{item['size'][1]}"
        print(
            f"{name:<40}{size:>12}{item['mean']:>8.1f}{item['contrast']:>8.1f}"
            f"{item['saturation']:>8.1f}{item['detail']:>8.1f}"
        )

    hero_name = args.hero if args.hero in images else pick(names, table, 0.75)
    side_pool = [name for name in names if name != hero_name]
    side_name = args.side if args.side in images and args.side != hero_name else pick(side_pool, table, 0.8)

    print(f"\n首屏：{hero_name}\n配图：{side_name}\n")

    hero_size = save_jpeg(resize(images[hero_name], HERO_EDGE), ROOT / "public" / "media" / "hero.jpg", 84)
    side_size = save_jpeg(resize(images[side_name], SIDE_EDGE), ROOT / "public" / "media" / "side.jpg", 82)

    items = []
    total = hero_size + side_size
    for index, name in enumerate(sorted(names), start=1):
        image = resize(images[name], GALLERY_EDGE)
        target = gallery_dir / f"{Path(name).stem}.jpg"
        size = save_jpeg(image, target)
        total += size
        items.append(
            {
                "id": Path(name).stem,
                "file": f"/media/gallery/{target.name}",
                "thumb": f"/media/gallery/{target.name}",
                "width": image.width,
                "height": image.height,
                "bytes": size,
                "lqip": lqip_data_uri(image),
                "alt": f"无毛猴照片 {index}",
            }
        )

    manifest = {
        "generatedFrom": str(args.src),
        "count": len(items),
        "hero": {"file": "/media/hero.jpg", "source": hero_name, "bytes": hero_size},
        "side": {"file": "/media/side.jpg", "source": side_name, "bytes": side_size},
        "items": items,
    }
    (data_dir / "curated.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    median = statistics.median(item["bytes"] for item in items)
    print(f"处理 {len(items)} 张：中位 {median / 1024:.0f} KB，合计 {total / 1048576:.1f} MB")
    print(f"清单写入 {data_dir / 'curated.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
