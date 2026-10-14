# Image test fixtures

`DisplayP3-v4.icc` is the 480-byte Display P3 profile from
[Compact ICC Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles/blob/bdd84663061bc4ae95ca70decff54f581e27f702/profiles/DisplayP3-v4.icc),
revision `bdd84663061bc4ae95ca70decff54f581e27f702`.
It is released under CC0 1.0; the upstream license is included in `CC0-1.0.txt`.

`tests/image_fixtures.py` embeds this profile in synthetic HEIC images. The browser
tests compare exported sRGB pixels with an independent Pillow/LittleCMS transform.
These generated colour fixtures contain no personal photographs or metadata.

`Gray-linear.icc` is a synthetic grayscale profile generated with LittleCMS 2's
`cmsCreateGrayProfile`, a D50 white point (`x=0.3457`, `y=0.3585`, `Y=1`) and a
linear tone curve from `cmsBuildGamma(NULL, 1.0)`. Its creation timestamp is fixed
to 1 January 2026. It contains no third-party image data and follows this
repository's MIT license. The fixture generator checks it with LittleCMS: a gray
sample of 128 transforms to sRGB 188. Browser tests verify that this unsupported
profile fails explicitly instead of silently exporting the original gray value.

## Real HEIC regression

`IMG_0308.heic` is the original user-supplied photograph, included with the repository owner's explicit permission as a test fixture. It contains a 1576-by-2100 Display P3 image with 10-bit 4:4:4 HEVC tiles that reproduced magenta/green corruption in libde265 1.0.15. The original bytes and metadata are preserved so the decoder regression remains reproducible. The CC0 licence above applies only to the ICC profile, not this photograph.

The image browser suite converts this fixture with EXIF off and on by default when `pillow-heif` is installed. `verify_real_heic.py` independently decodes it and checks colour, geometry and metadata; no converted derivative is stored in Git. `TEST_HEIC` can override this case with another external photo. Other personal photos still require explicit permission before inclusion.

SHA-256: `6b30d4b7036dc4a8659c0270ab266615916f9c0980f52ed91517e7986f476070`.
