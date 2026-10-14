#!/usr/bin/env bash
set -euo pipefail

# Manual dependency rebuild only; normal development and Pages need no build step.
# Activate Emscripten 3.1.61 and install CMake 3.31.6 before running this script.
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/pdf-heif-build.XXXXXX")
cd "$build_dir"

curl -fL https://github.com/strukturag/libheif/releases/download/v1.23.6/libheif-1.23.6.tar.gz -o libheif-1.23.6.tar.gz
curl -fL https://github.com/strukturag/libde265/releases/download/v1.1.3/libde265-1.1.3.tar.gz -o libde265-1.1.3.tar.gz
sha256sum --check <<'CHECKSUMS'
4484346dc5995319dbc11e3a1c35d0a2ec46511ce370900869337fd2c7033125  libheif-1.23.6.tar.gz
554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905  libde265-1.1.3.tar.gz
CHECKSUMS
tar -xzf libheif-1.23.6.tar.gz
tar -xzf libde265-1.1.3.tar.gz

emcmake cmake -S libde265-1.1.3 -B de265-build \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DENABLE_SDL=OFF -DENABLE_SIMD=OFF -DENABLE_DECODER=OFF \
  -DCMAKE_INSTALL_PREFIX="$build_dir/install"
cmake --build de265-build --parallel 8
cmake --install de265-build

emcmake cmake -S libheif-1.23.6 -B heif-build \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DENABLE_PLUGIN_LOADING=OFF -DENABLE_MULTITHREADING_SUPPORT=OFF \
  -DWITH_GDK_PIXBUF=OFF -DWITH_EXAMPLES=OFF -DBUILD_TESTING=OFF \
  -DBUILD_DOCUMENTATION=OFF -DWITH_LIBSHARPYUV=OFF \
  -DWITH_X265=OFF -DWITH_X264=OFF -DWITH_OpenH264_DECODER=OFF \
  -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF \
  -DLIBDE265_INCLUDE_DIR="$build_dir/install/include" \
  -DLIBDE265_LIBRARY="$build_dir/install/lib/libde265.a"
cmake --build heif-build --parallel 8

# Preserve the C API used for ICC/NCLX and EXIF alongside the upstream JS wrapper.
heic_exports=$("$EMSDK/upstream/bin/llvm-nm" heif-build/libheif/libheif.a --format=just-symbols |
  awk '/^(heif_|de265_)[A-Za-z0-9_]+$/ {print "_" $0}' | sort -u | paste -sd, -)
emcc -Wl,--whole-archive heif-build/libheif/libheif.a -Wl,--no-whole-archive \
  install/lib/libde265.a -lembind --post-js libheif-1.23.6/post.js \
  -sEXPORTED_FUNCTIONS="$heic_exports,_free,_malloc,_memcpy" \
  -sMODULARIZE -sEXPORT_NAME=libheif -sWASM_ASYNC_COMPILATION=0 \
  -sALLOW_MEMORY_GROWTH -sSINGLE_FILE=1 -O3 -o libheif-bundle.js

destination="$repo_dir/src/vendor/libheif-1.23.6"
mkdir -p "$destination"
cp libheif-bundle.js "$destination/"
cp libheif-1.23.6/COPYING "$destination/COPYING-libheif.txt"
cp libde265-1.1.3/COPYING "$destination/COPYING-libde265.txt"
cp "$EMSDK/upstream/emscripten/LICENSE" "$destination/LICENSE-emscripten.txt"
cp "$EMSDK/upstream/emscripten/system/lib/libc/musl/COPYRIGHT" "$destination/LICENSE-musl.txt"
cp "$EMSDK/upstream/emscripten/system/lib/libcxx/LICENSE.TXT" "$destination/LICENSE-libcxx.txt"
cp "$EMSDK/upstream/emscripten/system/lib/libcxxabi/LICENSE.TXT" "$destination/LICENSE-libcxxabi.txt"
cp "$EMSDK/upstream/emscripten/system/lib/compiler-rt/LICENSE.TXT" "$destination/LICENSE-compiler-rt.txt"
printf 'Decoder rebuilt from unmodified sources in %s\n' "$build_dir"
