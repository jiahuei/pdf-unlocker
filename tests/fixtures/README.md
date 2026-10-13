# Image test profiles

`DisplayP3-v4.icc` is the 480-byte Display P3 profile from
[Compact ICC Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles/blob/bdd84663061bc4ae95ca70decff54f581e27f702/profiles/DisplayP3-v4.icc),
revision `bdd84663061bc4ae95ca70decff54f581e27f702`.
It is released under CC0 1.0; the upstream license is included in `CC0-1.0.txt`.

`tests/image_fixtures.py` embeds this profile in synthetic HEIC images. The browser
tests compare exported sRGB pixels with an independent Pillow/LittleCMS transform.
The fixtures contain no personal photographs or metadata.
