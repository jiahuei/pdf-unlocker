"""Generate synthetic image fixtures for the converter's browser regressions."""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ORIENTATION_TAG = 274
ROTATE_90_CW = 6


def gradient(size, marker):
    """Return an asymmetric gradient with a corner marker, so orientation is verifiable."""
    width, height = size
    image = Image.new("RGB", size)
    draw = ImageDraw.Draw(image)
    for x in range(width):
        draw.line([(x, 0), (x, height)], fill=(x % 256, 40, 255 - (x % 256)))
    draw.rectangle([10, 10, width // 6, height // 5], fill=marker)
    return image


def write_heif_fixtures(directory):
    """Write single and multi-image HEIC fixtures when the optional encoder is installed."""
    try:
        import pillow_heif
    except ImportError:
        print("pillow-heif unavailable: HEIC fixtures skipped", file=sys.stderr)
        return
    pillow_heif.register_heif_opener()
    gradient((640, 400), (255, 0, 0)).save(directory / "photo.heic", quality=90)
    multi = pillow_heif.from_pillow(gradient((320, 200), (0, 0, 255)))
    multi.add_from_pillow(gradient((160, 120), (255, 255, 0)))
    multi.save(directory / "multi.heic")


def write_fixtures(directory):
    """Write the still, rotated, transparent, animated, oversized and invalid inputs."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    gradient((640, 400), (255, 0, 0)).save(directory / "photo.jpg", quality=90)
    gradient((200, 150), (0, 0, 255)).save(directory / "photo.png")
    gradient((300, 200), (0, 128, 0)).save(directory / "photo.webp", quality=90)

    transparent = Image.new("RGBA", (120, 90), (0, 0, 0, 0))
    ImageDraw.Draw(transparent).rectangle([10, 10, 60, 50], fill=(255, 0, 0, 128))
    transparent.save(directory / "alpha.png")

    # Stored landscape but displayed portrait: the decoder must apply this orientation itself.
    rotated = gradient((600, 300), (0, 255, 0))
    exif = rotated.getexif()
    exif[ORIENTATION_TAG] = ROTATE_90_CW
    rotated.save(directory / "exif6.jpg", exif=exif.tobytes(), quality=90)

    frames = [
        Image.new("RGB", (80, 60), colour) for colour in ((255, 0, 0), (0, 255, 0))
    ]
    for name in ("anim.webp", "anim.png", "anim.gif"):
        frames[0].save(
            directory / name,
            save_all=True,
            append_images=frames[1:],
            duration=100,
            loop=0,
        )

    # A solid colour keeps the file small while decoding past the documented pixel limit.
    Image.new("RGB", (8000, 7000), (12, 34, 56)).save(directory / "huge.png")
    # The size limit is checked before the bytes are read, so a sparse placeholder is enough.
    with open(directory / "oversize.jpg", "wb") as oversize:
        oversize.truncate(41 * 1024 * 1024)
    (directory / "notes.txt").write_text("This is not an image.\n")
    (directory / "corrupt.heic").write_bytes(b"\x00\x00\x00\x18ftypheic" + bytes(64))
    write_heif_fixtures(directory)


if __name__ == "__main__":
    write_fixtures(sys.argv[1])
