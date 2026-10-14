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

## Rebuilding on Linux

Normal development and Pages deployment use the checked-in bundle and need no compiler. The build recipe is [`scripts/build-heif.sh`](../../../scripts/build-heif.sh); the commands below install its toolchain and run it without depending on a previous build directory.

### 1. Install prerequisites

The verified platform is Ubuntu 22.04 on x86-64 Linux, with Python 3.12.7 and GNU Make 4.3. Use Bash and allow network access to GitHub, Google's Emscripten download storage and PyPI. Allow several GB of free space for the SDK and build trees. The script builds with eight parallel jobs.

On Debian/Ubuntu, install missing system prerequisites:

```sh
sudo apt-get update
sudo apt-get install --yes bash ca-certificates curl git make python3 python3-venv tar gzip xz-utils coreutils gawk
```

The commands below assume an existing checkout of this repository and start in its root. The SDK supplies Clang, LLVM, its Node runtime and the WebAssembly system libraries. Native libheif/libde265 development packages are unnecessary.

### 2. Install the exact build tools

Use a fresh Bash terminal without another Emscripten SDK activated. Keep this terminal open through the build; the path variables below belong to this shell.

```sh
set -e
heif_repo_dir="$PWD"
heif_tools_dir=$(mktemp -d /tmp/pdf-heif-tools.XXXXXX)

python3 -m venv "$heif_tools_dir/build-tools"
"$heif_tools_dir/build-tools/bin/python" -m pip install cmake==3.31.6

git clone --depth 1 --branch 3.1.61 https://github.com/emscripten-core/emsdk.git "$heif_tools_dir/emsdk"
test "$(git -C "$heif_tools_dir/emsdk" rev-parse HEAD)" = ca7b40ae222a2d8763b6ac845388744b0e57cfb7
"$heif_tools_dir/emsdk/emsdk" install 3.1.61
"$heif_tools_dir/emsdk/emsdk" activate 3.1.61
source "$heif_tools_dir/emsdk/emsdk_env.sh"
export PATH="$heif_tools_dir/build-tools/bin:$PATH"
export CMAKE_GENERATOR='Unix Makefiles'
export LC_ALL=C.UTF-8

emcc --version
cmake --version
```

The version output must report Emscripten **3.1.61** and CMake **3.31.6**. Installing CMake in the virtual environment avoids modifying the system Python installation; putting its `bin` directory first selects that version for both `emcmake` and the build. Sourcing `emsdk_env.sh` also sets `EMSDK`, which the script needs to locate `llvm-nm` and licence files. Installation or activation alone is insufficient. The generator and locale match the verified build, including deterministic sorting of exported symbols. Repeat the environment setup commands if you open another terminal.

The SDK release resolves to `sdk-releases-28e4a74b579b4157bda5fc34f23c7d3905a8bd6c-64bit` and includes Node 18.20.3. This Node runtime is for the compiler; repository formatting and Node tests use Node 24 in a separate terminal.

### 3. Build from the verified source archives

```sh
cd "$heif_repo_dir"
bash -n scripts/build-heif.sh
set -o pipefail
bash scripts/build-heif.sh 2>&1 | tee "$heif_tools_dir/build.log"
```

The script downloads the following unmodified release archives and checks their SHA-256 hashes before extraction:

| Archive                 | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `libheif-1.23.6.tar.gz` | `4484346dc5995319dbc11e3a1c35d0a2ec46511ce370900869337fd2c7033125` |
| `libde265-1.1.3.tar.gz` | `554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905` |

It builds a static libde265 decoder first, then links libheif against that archive explicitly. Unneeded encoders, plugin loading, multithreading, examples and tests are disabled by the flags in the script. The final `emcc` command includes the upstream `post.js` wrapper, exposes the `heif_*` and `de265_*` C functions plus memory helpers, and embeds WASM into one JavaScript file. The C exports are needed for colour profiles and EXIF; replacing this with a wrapper-only build would break those paths.

The build overwrites `libheif-bundle.js` and the seven `COPYING-*.txt` / `LICENSE-*.txt` notices in this directory. Inspect `git status` before running it to avoid replacing local edits. It leaves a fresh `${TMPDIR:-/tmp}/pdf-heif-build.*` directory containing the source archives, extracted sources, CMake build trees and intermediate libraries. Its final output prints that directory. Keep the log and build tree when investigating a failure.

### 4. Verify the result

From the repository root, the current pinned build must pass:

```sh
sha256sum --check <<'CHECKSUM'
11ffc6176360076fb15c7f7ca29c6129410184efd4688dee6d17dddbd6fff08e  src/vendor/libheif-1.23.6/libheif-bundle.js
CHECKSUM
node --check src/vendor/libheif-1.23.6/libheif-bundle.js
git diff --exit-code -- src/vendor/libheif-1.23.6/libheif-bundle.js 'src/vendor/libheif-1.23.6/COPYING-*.txt' 'src/vendor/libheif-1.23.6/LICENSE-*.txt'
```

For an unchanged rebuild, the bundle and notices should produce no Git diff. Do not format the generated bundle; it is excluded from Prettier. The checksum is specific to this recipe and toolchain, not a promise that other compiler versions produce identical output. If it differs, first compare the selected SDK/CMake versions, generator, source hashes and build log before accepting a new binary.

After an intentional decoder or build-recipe change, follow the [browser setup and verification commands](../../../README.md#development-and-verification) in a separate terminal with Node 24. Install the pinned `pillow-heif` dependency so HEIC coverage is not skipped, serve `src/` on port 8001, then run:

```sh
env -u TEST_HEIC PLAYWRIGHT_MODULE=/tmp/pdf-unlocker-browser-tests/node_modules/playwright PYTHONPATH=/tmp/pdf-unlocker-test-python node tests/image-browser.test.cjs
```

The suite checks the synthetic `scaling-list.heic` colour regression and the approved `tests/fixtures/IMG_0308.heic` automatically, including both EXIF modes and independent Pillow/LittleCMS comparisons. `TEST_HEIC` is only needed to substitute another camera photo. Passing a syntax check or getting an image on screen is not sufficient colour verification.

### Reproduction record

Verified on 14 October 2026 on the platform above: installed CMake 3.31.6 in a new virtual environment, cloned and installed SDK 3.1.61 into a new directory, and ran an unchanged copy of `scripts/build-heif.sh` from commit `ff708abe20b45aad94d3d83d0e21e25ba3eccf06` in an isolated output tree. The script downloaded fresh release archives and built from fresh source directories. The generated bundle matched the SHA-256 above, and `cmp` confirmed that the bundle and all seven notices matched the checked-in files byte for byte. `node --check` passed on the freshly built bundle. System prerequisites were already installed; this was a fresh SDK/CMake/source build on an existing Ubuntu host, not a fresh OS installation.

The identical checked-in bundle had already passed the image browser suite (422 assertions, 66 independently verified converted downloads, and eight byte-for-byte input download comparisons), including the approved camera photo. The browser suite was not rerun for this documentation-only change because the rebuild did not change any runtime bytes.
