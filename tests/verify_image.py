"""Independently check a downloaded conversion: real bytes, geometry, transparency and pixels."""

import argparse
from pathlib import Path

from PIL import Image

try:  # A HEIC source needs the optional plugin registered before Pillow can open it.
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pass

TOLERANCE = 8
ORIENTATION_TAG = 274
GPS_IFD = 0x8825
EXIF_IFD = 0x8769
# Make, Model, DateTime and Artist: the shooting details the checkbox promises to keep.
RETAINED_TAGS = (271, 272, 306, 315)


def check_exif(image, exif_from):
    """Assert metadata is dropped by default, or retained upright when it was asked for."""
    exif = image.getexif()
    if not exif_from:
        assert not exif, "output must not carry source metadata"
        return
    with Image.open(Path(exif_from)) as source:
        expected = source.getexif()
        for tag in RETAINED_TAGS:
            assert exif.get(tag) == expected.get(tag), f"tag {tag} was not retained"
        # Stored geometry must describe the exported pixels after orientation is applied.
        for actual_ifd, expected_ifd, tags in (
            (exif, expected, (256, 257)),
            (exif.get_ifd(EXIF_IFD), expected.get_ifd(EXIF_IFD), (40962, 40963)),
        ):
            for tag, dimension in zip(tags, image.size, strict=True):
                if tag in expected_ifd:
                    assert actual_ifd.get(tag) == dimension, (
                        f"dimension tag {tag}={actual_ifd.get(tag)} != {dimension}"
                    )
        assert exif.get_ifd(GPS_IFD) == expected.get_ifd(GPS_IFD), (
            "the GPS position was not retained"
        )
    # The converted pixels are already upright, so viewers must not rotate them a second time.
    assert exif.get(ORIENTATION_TAG, 1) == 1, "retained EXIF must be marked upright"


def verify_image(
    path, expected_format, size, transparency, pixel, reference=None, exif_from=None
):
    """Assert the file really is the advertised format, with the expected geometry and pixels."""
    with Image.open(Path(path)) as image:
        assert image.format == expected_format, f"{image.format} != {expected_format}"
        check_exif(image, exif_from)
        width, height = (int(part) for part in size.split("x"))
        assert image.size == (width, height), f"{image.size} != {(width, height)}"
        # Canvas output is always RGBA, so "none" means fully opaque rather than no alpha band.
        extrema = image.convert("RGBA").getchannel("A").getextrema()
        assert (extrema[0] < 255) == (transparency == "kept"), (
            f"alpha extrema {extrema}"
        )
        for sample in pixel or []:
            x, y, *expected = (int(part) for part in sample.split(","))
            actual = image.convert("RGBA").getpixel((x, y))[: len(expected)]
            assert all(
                abs(actual[index] - value) <= TOLERANCE
                for index, value in enumerate(expected)
            ), f"pixel {(x, y)}={actual} expected {tuple(expected)}"
        if reference:
            with Image.open(reference) as expected_image:
                actual_rgba = image.convert("RGBA")
                expected_rgba = expected_image.convert("RGBA")
                assert actual_rgba.size == expected_rgba.size
                for y in range(4, height, 8):
                    for x in range(4, width, 8):
                        actual = actual_rgba.getpixel((x, y))
                        expected = expected_rgba.getpixel((x, y))
                        assert all(
                            abs(a - b) <= TOLERANCE
                            for a, b in zip(actual, expected, strict=True)
                        ), f"colour at {(x, y)}={actual} expected {expected}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path")
    parser.add_argument(
        "--format",
        dest="expected_format",
        required=True,
        choices=["JPEG", "PNG", "WEBP"],
    )
    parser.add_argument("--size", required=True, help="expected WIDTHxHEIGHT")
    parser.add_argument("--transparency", default="none", choices=["none", "kept"])
    parser.add_argument(
        "--pixel", action="append", help="expected X,Y,R,G,B[,A]; repeatable"
    )
    parser.add_argument("--reference", help="independent sRGB reference image")
    parser.add_argument(
        "--exif-from",
        help="source whose EXIF, including GPS, the output must retain upright",
    )
    arguments = parser.parse_args()
    verify_image(
        arguments.path,
        arguments.expected_format,
        arguments.size,
        arguments.transparency,
        arguments.pixel,
        arguments.reference,
        arguments.exif_from,
    )
