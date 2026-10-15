"""Generate synthetic image fixtures for the converter's browser regressions."""

import io
import struct
import sys
from pathlib import Path

from PIL import Image, ImageCms, ImageDraw, ImageOps
from PIL.TiffImagePlugin import IFDRational

ORIENTATION_TAG = 274
ROTATE_90_CW = 6
GPS_IFD = 0x8825
EXIF_IFD = 0x8769
# An obviously synthetic position, one arc-second off Null Island, so no real place is recorded.
SYNTHETIC_GPS = {
    1: "N",
    2: (IFDRational(0), IFDRational(0), IFDRational(1)),
    3: "E",
    4: (IFDRational(0), IFDRational(0), IFDRational(1)),
    6: IFDRational(1234),
    7: (IFDRational(1), IFDRational(2), IFDRational(3)),
}


def gps_exif(orientation=None, size=None):
    """Return EXIF bytes carrying shooting details and a synthetic GPS position."""
    exif = Image.Exif()
    exif[271] = "Synthetic"
    exif[306] = "2026:01:02 03:04:05"
    exif[GPS_IFD] = SYNTHETIC_GPS
    if orientation:
        exif[ORIENTATION_TAG] = orientation
    if size:
        exif[256], exif[257] = size
        exif[EXIF_IFD] = {40962: size[0], 40963: size[1]}
    return exif.tobytes()


def gradient(size, marker):
    """Return an asymmetric gradient with a corner marker, so orientation is verifiable."""
    width, height = size
    image = Image.new("RGB", size)
    draw = ImageDraw.Draw(image)
    for x in range(width):
        draw.line([(x, 0), (x, height)], fill=(x % 256, 40, 255 - (x % 256)))
    draw.rectangle([10, 10, width // 6, height // 5], fill=marker)
    return image


def bt709_to_srgb(channel):
    """Map a decoded BT.709 channel through linear light to an independent sRGB reference."""
    value = channel / 255
    linear = value / 4.5 if value < 0.081 else ((value + 0.099) / 1.099) ** (1 / 0.45)
    srgb = (
        12.92 * linear if linear <= 0.0031308 else 1.055 * linear ** (1 / 2.4) - 0.055
    )
    return round(255 * srgb)


def write_heif_fixtures(directory):
    """Write single and multi-image HEIC fixtures when the optional encoder is installed."""
    try:
        import pillow_heif
    except ImportError:
        print("pillow-heif unavailable: HEIC fixtures skipped", file=sys.stderr)
        return
    pillow_heif.register_heif_opener()
    gradient((640, 400), (255, 0, 0)).save(directory / "photo.heic", quality=90)
    # Match the LOC still's mif1 major plus mif1/heic/hevc compatible brands. Editing
    # existing slots preserves item offsets; the hevc compatibility must not imply animation.
    compatible = bytearray((directory / "photo.heic").read_bytes())
    assert compatible[4:8] == b"ftyp" and int.from_bytes(compatible[:4], "big") >= 28
    compatible[8:12] = b"mif1"
    compatible[16:28] = b"mif1heichevc"
    (directory / "still-compatible.heic").write_bytes(compatible)
    with (
        Image.open(directory / "photo.heic") as original,
        Image.open(directory / "still-compatible.heic") as modified,
    ):
        assert modified.size == original.size and modified.mode == original.mode
        assert modified.tobytes() == original.tobytes(), (
            "brand edits must preserve pixels"
        )
    # A camera photo carries its EXIF in a separate HEIF item, which only the decoder can read.
    gradient((640, 400), (255, 0, 0)).save(
        directory / "gps.heic", quality=90, exif=gps_exif(size=(640, 400))
    )
    with Image.open(directory / "gps.heic") as tagged:
        assert tagged.getexif().get_ifd(GPS_IFD), "the HEIC fixture must carry GPS"
    # HEIF declares the TIFF position after its four-byte prefix; it need not start nearby.
    tiff = gps_exif(size=(640, 400))[6:]
    payload = (20).to_bytes(4, "big") + bytes(20) + tiff
    gradient((640, 400), (255, 0, 0)).save(
        directory / "gps-offset.heic",
        quality=90,
        metadata=[{"type": "Exif", "content_type": "", "data": payload}],
    )
    with Image.open(directory / "gps-offset.heic") as tagged:
        assert tagged.getexif().get_ifd(GPS_IFD), "the offset HEIC must carry GPS"
    gradient((640, 400), (255, 0, 0)).save(
        directory / "untagged.heic", quality=90, save_nclx_profile=False
    )
    with Image.open(directory / "untagged.heic") as untagged:
        assert not untagged.info.get("icc_profile")
        assert not untagged.info.get("nclx_profile")
    multi = pillow_heif.from_pillow(gradient((320, 200), (0, 0, 255)))
    multi.add_from_pillow(gradient((160, 120), (255, 255, 0)))
    multi.save(directory / "multi.heic")

    # libde265 before 1.0.16 selects the wrong scaling matrix for 32x32 chroma
    # blocks in 4:4:4 images. A smooth gradient makes the encoder use those blocks.
    scaling = gradient((256, 128), (255, 0, 0))
    pixels = b"".join(struct.pack("<H", channel * 4) for channel in scaling.tobytes())
    pillow_heif.from_bytes("RGB;10", scaling.size, pixels).save(
        directory / "scaling-list.heic",
        quality=80,
        chroma="444",
        save_nclx_profile=False,
        enc_params={"x265:scaling-list": "default"},
    )
    with Image.open(directory / "scaling-list.heic") as decoded:
        assert decoded.info["bit_depth"] == 10
        assert decoded.info["chroma"] == 444
        decoded.save(directory / "scaling-list-reference.png")

    # Public-domain profile plus synthetic swatches: the reference uses LittleCMS, independently
    # of the browser's colour management, and accounts for the HEIC encoder's rounding.
    profile = (Path(__file__).parent / "fixtures" / "DisplayP3-v4.icc").read_bytes()
    colour = Image.new("RGB", (64, 32), (200, 100, 50))
    ImageDraw.Draw(colour).rectangle([32, 0, 63, 31], fill=(70, 170, 130))
    colour.save(directory / "p3.heic", icc_profile=profile, quality=100)
    with Image.open(directory / "p3.heic") as decoded:
        ImageCms.profileToProfile(
            decoded,
            ImageCms.ImageCmsProfile(io.BytesIO(profile)),
            ImageCms.createProfile("sRGB"),
            outputMode="RGB",
        ).save(directory / "p3-reference.png")

    # A valid linear Gray profile must be rejected, rather than attached to an RGB PNG.
    gray_profile = (Path(__file__).parent / "fixtures" / "Gray-linear.icc").read_bytes()
    Image.new("L", (64, 64), 128).save(
        directory / "gray.heic", icc_profile=gray_profile, quality=100
    )
    with Image.open(directory / "gray.heic") as decoded:
        assert decoded.mode == "L"
        assert decoded.info["icc_profile"] == gray_profile
        reference = ImageCms.profileToProfile(
            decoded,
            ImageCms.ImageCmsProfile(io.BytesIO(gray_profile)),
            ImageCms.createProfile("sRGB"),
            outputMode="RGB",
        )
        assert reference.getpixel((32, 32)) == (188, 188, 188)

    transparent_colour = colour.convert("RGBA")
    transparent_colour.putalpha(128)
    transparent_colour.save(
        directory / "p3-alpha.heic", icc_profile=profile, quality=100
    )
    with Image.open(directory / "p3-alpha.heic") as decoded:
        assert decoded.mode == "RGBA"
        ImageCms.profileToProfile(
            decoded,
            ImageCms.ImageCmsProfile(io.BytesIO(profile)),
            ImageCms.createProfile("sRGB"),
            outputMode="RGBA",
        ).save(directory / "p3-alpha-reference.png")

    for name, primaries, transfer in (
        ("p3-nclx", 12, 13),
        ("bt709", 1, 1),
        ("hdr", 9, 16),
    ):
        nclx = {
            "color_primaries": primaries,
            "transfer_characteristics": transfer,
            "matrix_coefficients": 6,
            "full_range_flag": 1,
        }
        # Set the source and output profiles alike so encoding preserves these synthetic RGB
        # values. The actual keyword is plural, despite the encoder's singular documentation.
        colour.save(
            directory / f"{name}.heic",
            quality=100,
            save_nclx_profile=True,
            nclx_profile=nclx,
            **nclx,
        )
        with Image.open(directory / f"{name}.heic") as decoded:
            assert not decoded.info.get("icc_profile")
            actual = decoded.info["nclx_profile"]
            assert all(actual[key] == value for key, value in nclx.items())
            if name == "p3-nclx":
                ImageCms.profileToProfile(
                    decoded,
                    ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                    ImageCms.createProfile("sRGB"),
                    outputMode="RGB",
                ).save(directory / "p3-nclx-reference.png")
            elif name == "bt709":
                # An independent Python reference inverts the BT.709 transfer curve, then
                # encodes sRGB; the HEIC decode already handles YCbCr and limited/full range.
                decoded.point(bt709_to_srgb).save(directory / "bt709-reference.png")


def write_fixtures(directory):
    """Write the still, rotated, transparent, animated, oversized and invalid inputs."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    gradient((640, 400), (255, 0, 0)).save(directory / "photo.jpg", quality=90)
    # MPO uses ordinary JPEG framing, but its MPF index declares the additional pictures.
    gradient((640, 400), (255, 0, 0)).save(
        directory / "multi.mpo",
        format="MPO",
        save_all=True,
        append_images=[gradient((640, 400), (0, 0, 255))],
    )
    with Image.open(directory / "multi.mpo") as multi:
        assert multi.n_frames == 2, "the MPO fixture must contain two pictures"
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

    # Rotation plus a position: the output must stay upright while the GPS block survives.
    gradient((600, 300), (0, 255, 0)).save(
        directory / "gps.jpg", quality=90, exif=gps_exif(ROTATE_90_CW, (600, 300))
    )
    with Image.open(directory / "gps.jpg") as tagged:
        assert tagged.getexif().get_ifd(GPS_IFD), "the JPEG fixture must carry GPS"

    # Browser WebP decoders may ignore EXIF orientation; verify every rotation and reflection.
    swatches = Image.new("RGB", (64, 32))
    draw = ImageDraw.Draw(swatches)
    for box, colour in (
        ((0, 0, 31, 15), (255, 0, 0)),
        ((32, 0, 63, 15), (0, 255, 0)),
        ((0, 16, 31, 31), (0, 0, 255)),
        ((32, 16, 63, 31), (255, 255, 0)),
    ):
        draw.rectangle(box, fill=colour)
    for orientation in range(1, 9):
        file = directory / f"oriented-{orientation}.webp"
        swatches.save(file, lossless=True, exif=gps_exif(orientation, (64, 32)))
        with Image.open(file) as decoded:
            ImageOps.exif_transpose(decoded).save(
                directory / f"oriented-{orientation}-reference.png"
            )

    # Valid JPEG marker fill before APP1 must not hide EXIF from the metadata scanner.
    padded = bytearray((directory / "gps.jpg").read_bytes())
    app1 = padded.index(b"Exif\0\0") - 4
    assert padded[app1 : app1 + 2] == b"\xff\xe1"
    padded[app1:app1] = b"\xff"
    (directory / "gps-marker-fill.jpg").write_bytes(padded)
    with Image.open(directory / "gps-marker-fill.jpg") as tagged:
        assert tagged.getexif().get_ifd(GPS_IFD), "marker fill must leave EXIF readable"

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

    # WebP permits unknown chunks: a lowercase name and odd payload must not hide animation.
    animated = bytearray((directory / "anim.webp").read_bytes())
    first_chunk_size = int.from_bytes(animated[16:20], "little")
    insertion = 20 + first_chunk_size + first_chunk_size % 2
    animated[insertion:insertion] = b"test" + (3).to_bytes(4, "little") + b"abc\0"
    animated[4:8] = (len(animated) - 8).to_bytes(4, "little")
    (directory / "anim-unknown.webp").write_bytes(animated)

    # A solid colour keeps the file small while decoding past the documented pixel limit.
    Image.new("RGB", (8000, 7000), (12, 34, 56)).save(directory / "huge.png")
    # The size limit is checked before the bytes are read, so a sparse placeholder is enough.
    with open(directory / "oversize.jpg", "wb") as oversize:
        oversize.truncate(41 * 1024 * 1024)
    (directory / "notes.txt").write_text("This is not an image.\n")
    # Complete ftyp headers are enough: sequence policy must reject before any image decode.
    (directory / "anim-hevc.heic").write_bytes(
        struct.pack(">I4s4sI", 16, b"ftyp", b"hevc", 0)
    )
    # Match the Nokia sequence and layered-still brands without embedding their image data.
    (directory / "anim-msf1.heic").write_bytes(
        struct.pack(">I4s4sI", 36, b"ftyp", b"msf1", 0) + b"msf1hevcheicmif1iso8"
    )
    (directory / "layered-heis.heic").write_bytes(
        struct.pack(">I4s4sI", 28, b"ftyp", b"heis", 0) + b"mif1heicheis"
    )
    # The major brand is recognizable even though the declared box extends past EOF.
    (directory / "truncated-ftyp.heic").write_bytes(
        struct.pack(">I4s4sI", 28, b"ftyp", b"heic", 0)
    )
    # A general ISO-BMFF container that only declares HEIF compatibility. Detection trusts the
    # major brand, so this is refused as an unsupported type instead of entering the HEIF path
    # and downloading the decoder before failing inside it.
    (directory / "mp4-compat.heic").write_bytes(
        struct.pack(">I4s4sI", 24, b"ftyp", b"mp41", 0) + b"mp41mif1"
    )
    (directory / "corrupt.heic").write_bytes(b"\x00\x00\x00\x18ftypheic" + bytes(64))
    write_heif_fixtures(directory)


if __name__ == "__main__":
    write_fixtures(sys.argv[1])
