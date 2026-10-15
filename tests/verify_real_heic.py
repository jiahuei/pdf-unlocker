"""Independently verify a conversion of the approved fixture or an external camera photo."""

import argparse
import io
import json
from pathlib import Path

import pillow_heif
from PIL import Image, ImageCms

from verify_image import GPS_IFD, check_exif

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
    with Image.open(Path(source)) as original:
        source_exif = original.getexif()
        source_has_exif = bool(source_exif)
        source_has_gps = bool(source_exif.get_ifd(GPS_IFD))
    with Image.open(Path(output)) as converted:
        assert converted.format == "JPEG", f"{converted.format} != JPEG"
        # libheif applies the container rotation, so equal sizes prove the orientation survived.
        assert converted.size == reference.size, f"{converted.size} != {reference.size}"
        # A source with no EXIF must not gain it, even when retention is requested.
        check_exif(converted, source if keep_exif and source_has_exif else None)
        left = reference.resize((GRID, GRID))
        right = converted.convert("RGB").resize((GRID, GRID))
        differences = [
            max(abs(actual[channel] - expected[channel]) for channel in range(3))
            for actual, expected in zip(left.getdata(), right.getdata())
        ]
    worst = max(differences)
    assert worst <= TOLERANCE, f"colour difference {worst} exceeds {TOLERANCE}"
    return {
        "output": Path(output).name,
        "size": reference.size,
        "profile": profile,
        "worst_channel_difference": worst,
        "mean_channel_difference": sum(differences) / len(differences),
        "source_has_exif": source_has_exif,
        "source_has_gps": source_has_gps,
        "exif": "kept" if keep_exif and source_has_exif else "absent",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source", help="the approved HEIC fixture or an external camera photo"
    )
    parser.add_argument("output", help="the JPEG downloaded from the converter")
    parser.add_argument(
        "--keep-exif",
        action="store_true",
        help="retain source EXIF upright when present; otherwise require no output EXIF",
    )
    arguments = parser.parse_args()
    print(
        json.dumps(
            verify_real_heic(arguments.source, arguments.output, arguments.keep_exif)
        )
    )
