#!/usr/bin/env bash
#
# Synthesize the CMakeLists.txt for one analyzer/KB compile job.
# Mirrors src/compile.ts:generateCompileCMakeLists in the vscode-nlp
# extension, with includes/libs pointed at the unpacked
# nlpengine-compile-libs-<platform>.zip from the engine release.
#
# Usage:
#   bash scripts/emit-cmake.sh \
#     --anapath      <dir>    # contains run/*.cpp, kb/*.cpp, StdAfx.h
#     --engine-libs  <dir>    # unpacked nlpengine-compile-libs-<platform>.zip
#     --analyzer     <name>   # base name for the output shared lib
#     --kb-only      true|false
#
# Writes <anapath>/CMakeLists.txt.

set -euo pipefail

ANAPATH=""
ENGINE_LIBS=""
ANALYZER=""
KB_ONLY="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --anapath)      ANAPATH="$2"; shift 2 ;;
    --engine-libs)  ENGINE_LIBS="$2"; shift 2 ;;
    --analyzer)     ANALYZER="$2"; shift 2 ;;
    --kb-only)      KB_ONLY="$2"; shift 2 ;;
    *) echo "emit-cmake.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$ANAPATH" ]     || { echo "emit-cmake.sh: --anapath required" >&2; exit 2; }
[ -n "$ENGINE_LIBS" ] || { echo "emit-cmake.sh: --engine-libs required" >&2; exit 2; }
[ -n "$ANALYZER" ]    || { echo "emit-cmake.sh: --analyzer required" >&2; exit 2; }
[ -d "$ANAPATH" ]     || { echo "emit-cmake.sh: --anapath not a directory: $ANAPATH" >&2; exit 2; }
[ -d "$ENGINE_LIBS" ] || { echo "emit-cmake.sh: --engine-libs not a directory: $ENGINE_LIBS" >&2; exit 2; }

# Use absolute, forward-slash paths CMake accepts on every platform.
# On Windows (MSYS bash on GH runners), plain `pwd` returns `/c/...` which
# Windows cmake cannot resolve. `pwd -W` returns Windows-style `C:/...`.
if [ "${OS:-}" = "Windows_NT" ]; then
  ANAPATH=$(cd "$ANAPATH" && pwd -W)
  ENGINE_LIBS=$(cd "$ENGINE_LIBS" && pwd -W)
else
  ANAPATH=$(cd "$ANAPATH" && pwd)
  ENGINE_LIBS=$(cd "$ENGINE_LIBS" && pwd)
fi

if [ "$KB_ONLY" = "true" ]; then
  SRC_GLOB="\"$ANAPATH/kb/*.cpp\""
  SRC_SCOPE="kb/"
else
  SRC_GLOB="\"$ANAPATH/run/*.cpp\" \"$ANAPATH/kb/*.cpp\""
  SRC_SCOPE="run/ or kb/"
fi

# Build include + lib block contents.
# nlpengine-compile-libs zip layout (per .github/workflows/build-*.yml in nlp-engine):
#   include/Api/...   ← engine public API
#   include/cs/...    ← engine internal headers used by generated code
#   lib/lib{prim,kbm,consh,words,lite}.{a|lib}
#   lib/libicu*.{a|lib}   (linux/mac; windows uses .lib import libs separately)
INCLUDE_LINES=""
for d in "$ENGINE_LIBS/include/Api" "$ENGINE_LIBS/include/cs" "$ENGINE_LIBS/include"; do
  if [ -d "$d" ]; then
    INCLUDE_LINES="${INCLUDE_LINES}    \"$d\""$'\n'
  fi
done

LIB_LINES=""
if [ -d "$ENGINE_LIBS/lib" ]; then
  while IFS= read -r -d '' lib; do
    LIB_LINES="${LIB_LINES}    \"$lib\""$'\n'
  done < <(find "$ENGINE_LIBS/lib" -maxdepth 1 -type f \( -name '*.a' -o -name '*.lib' \) -print0 | sort -z)
fi

if [ -z "$LIB_LINES" ]; then
  echo "emit-cmake.sh: no engine static libs found under $ENGINE_LIBS/lib" >&2
  exit 3
fi

OUT="$ANAPATH/CMakeLists.txt"

cat > "$OUT" <<EOF
cmake_minimum_required(VERSION 3.16)
project(nlp_generated_library LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(ANALYZER_DIR "$ANAPATH")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "$ANAPATH")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "$ANAPATH")
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "$ANAPATH")
foreach(OUTPUTCONFIG \${CMAKE_CONFIGURATION_TYPES})
    string(TOUPPER \${OUTPUTCONFIG} OUTPUTCONFIG_UPPER)
    set(CMAKE_LIBRARY_OUTPUT_DIRECTORY_\${OUTPUTCONFIG_UPPER} "$ANAPATH")
    set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_\${OUTPUTCONFIG_UPPER} "$ANAPATH")
    set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY_\${OUTPUTCONFIG_UPPER} "$ANAPATH")
endforeach()

file(GLOB GENERATED_CPP $SRC_GLOB)
if(NOT GENERATED_CPP)
    message(FATAL_ERROR "No generated C++ sources found in $SRC_SCOPE.")
endif()

add_library(nlp_generated SHARED \${GENERATED_CPP})
set_target_properties(nlp_generated PROPERTIES OUTPUT_NAME "$ANALYZER")

target_include_directories(nlp_generated PRIVATE
    "$ANAPATH"
    "$ANAPATH/run"
    "$ANAPATH/kb"
${INCLUDE_LINES})

set(NLP_ENGINE_LIBRARIES
${LIB_LINES})

target_link_libraries(nlp_generated PRIVATE \${NLP_ENGINE_LIBRARIES})

if(WIN32)
    target_compile_definitions(nlp_generated PRIVATE _CRT_SECURE_NO_WARNINGS)
    if(MSVC)
        target_compile_options(nlp_generated PRIVATE /wd4005 /FI"StdAfx.h")
    endif()
else()
    target_compile_options(nlp_generated PRIVATE -include StdAfx.h)
    find_library(DL_LIBRARY dl)
    if(DL_LIBRARY)
        target_link_libraries(nlp_generated PRIVATE \${DL_LIBRARY})
    endif()
endif()
EOF

echo "emit-cmake.sh: wrote $OUT"
