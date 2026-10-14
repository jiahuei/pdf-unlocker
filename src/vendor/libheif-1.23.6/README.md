# HEIC decoder

`libheif-bundle.js` contains **libheif 1.23.6** and **libde265 1.1.3**, compiled to WebAssembly with Emscripten 3.1.61. It includes the upstream JavaScript wrapper and embedded WASM, so the application can load it on demand through one retryable script request at any Pages prefix.

This build replaces libheif-js 1.23.5, whose libde265 1.0.15 produces magenta/green patches in 10-bit 4:4:4 HEICs using 32-by-32 chroma transform blocks. The [upstream fix](https://github.com/strukturag/libde265/commit/9959d272c38ac6c198977ba1354ed7f1963d0435) is included in libde265 1.1.3. The decoder's C API remains available for source colour profiles and EXIF.

## Sources and licences

The sources are unmodified. Exact corresponding source archives are available here:

- [libheif 1.23.6](https://github.com/strukturag/libheif/releases/download/v1.23.6/libheif-1.23.6.tar.gz), LGPL-3.0; see [COPYING-libheif.txt](COPYING-libheif.txt).
- [libde265 1.1.3](https://github.com/strukturag/libde265/releases/download/v1.1.3/libde265-1.1.3.tar.gz), LGPL-3.0; see [COPYING-libde265.txt](COPYING-libde265.txt).
- [Emscripten 3.1.61](https://github.com/emscripten-core/emscripten/tree/3.1.61), whose generated runtime licence is in [LICENSE-emscripten.txt](LICENSE-emscripten.txt).
- Its linked runtime libraries: [musl](LICENSE-musl.txt), [libc++](LICENSE-libcxx.txt), [libc++abi](LICENSE-libcxxabi.txt) and [compiler-rt](LICENSE-compiler-rt.txt). Their exact sources are included in the pinned Emscripten source tree above.

The library remains separate from application code and can be replaced with a compatible build. The application's MIT licence does not replace these licences.

## Rebuilding

Normal development and deployment use the checked-in bundle and need no compiler. To rebuild on Linux, install GNU Make, curl, Python, the [Emscripten SDK 3.1.61](https://github.com/emscripten-core/emsdk/tree/3.1.61), and CMake 3.31.6 (`python3 -m pip install cmake==3.31.6`). Activate the SDK, then run from the repository root:

```sh
source /path/to/emsdk/emsdk_env.sh
bash scripts/build-heif.sh
```

The script checks the source archives' SHA-256 hashes and builds in a fresh temporary directory. It copies the bundle and notices into this directory. Run the documented image browser suite, including `TEST_HEIC` for a private real-camera photo, after any decoder change. The synthetic `scaling-list.heic` regression guards against the original colour corruption.
