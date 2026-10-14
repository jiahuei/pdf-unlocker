"""Independently verify a conversion of a real camera photo supplied outside the repository."""

import argparse
import io
from pathlib import Path

import pillow_heif
from PIL import Image, ImageCms

from verify_image import check_exif

# HEVC decoding plus a lossy JPEG re-encode; compared after downscaling to a coarse grid.
TOLERANCE = 8
GRID = 32


def reference_pixels(handle):
    """Decode the source with an independent libheif and map it to sRGB when it is tagged."""
    reference = handle.to_pillow().convert("RGBA")
    profile = handle.info.get("icc_profile")
    profile_name = None
    if profile:
        source_profile = ImageCms.ImageCmsProfile(io.BytesIO(profile))
        reference = ImageCms.profileToProfile(
            reference,
            source_profile,
            ImageCms.createProfile("sRGB"),
            outputMode="RGBA",
        )
        profile_name = ImageCms.getProfileName(source_profile).strip()
    # HEIC can carry alpha even for camera photos. JPEG flattens it over white after
    # colour conversion, so dropping alpha here would falsely report colour errors.
    flattened = Image.new("RGBA", reference.size, "white")
    flattened.alpha_composite(reference)
    return flattened.convert("RGB"), profile_name


def verify_real_heic(source, output, keep_exif=False):
    """Assert geometry, orientation, metadata policy and colour fidelity of a download."""
    handle = pillow_heif.open_heif(Path(source))
    reference, profile = reference_pixels(handle)
    with Image.open(Path(output)) as converted:
        assert converted.format == "JPEG", f"{converted.format} != JPEG"
        # libheif applies the container rotation, so equal sizes prove the orientation survived.
        assert converted.size == reference.size, f"{converted.size} != {reference.size}"
        check_exif(converted, source if keep_exif else None)
        left = reference.resize((GRID, GRID))
        right = converted.convert("RGB").resize((GRID, GRID))
        differences = [
            max(abs(actual[channel] - expected[channel]) for channel in range(3))
            for actual, expected in zip(left.getdata(), right.getdata())
        ]
    worst = max(differences)
    assert worst <= TOLERANCE, f"colour difference {worst} exceeds {TOLERANCE}"
    print(
        f"verified {Path(output).name}: {reference.size[0]}x{reference.size[1]}, "
        f"profile {profile or 'untagged'}, worst channel difference {worst}, "
        f"mean {sum(differences) / len(differences):.2f}"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source", help="the real HEIC photo, kept outside the repository"
    )
    parser.add_argument("output", help="the JPEG downloaded from the converter")
    parser.add_argument(
        "--keep-exif",
        action="store_true",
        help="expect the source EXIF, including GPS, to be retained upright",
    )
    arguments = parser.parse_args()
    verify_real_heic(arguments.source, arguments.output, arguments.keep_exif)
