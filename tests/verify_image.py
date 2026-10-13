"""Independently check a downloaded conversion: real bytes, geometry, transparency and pixels."""

import argparse
from pathlib import Path

from PIL import Image

TOLERANCE = 8


def verify_image(path, expected_format, size, transparency, pixel, reference=None):
    """Assert the file really is the advertised format, with the expected geometry and pixels."""
    with Image.open(Path(path)) as image:
        assert image.format == expected_format, f"{image.format} != {expected_format}"
        assert not image.getexif(), "output must not carry source metadata"
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
    arguments = parser.parse_args()
    verify_image(
        arguments.path,
        arguments.expected_format,
        arguments.size,
        arguments.transparency,
        arguments.pixel,
        arguments.reference,
    )
