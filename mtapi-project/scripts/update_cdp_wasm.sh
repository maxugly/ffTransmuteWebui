#!/usr/bin/env bash
# Vendor the pinned cdp-wasm runtime into the app's static tree (Phase 1).
# Spec: docs/cdp-integration-spec.md §2.2/§7.1 — browser Worker execution,
# no npm (invariant 7): the package's built JS+WASM is served as static files.
#
# Idempotent: verifies the pinned sha512 before touching the target dir.
# Run again verbatim to restore/update the pinned version.
set -euo pipefail

VERSION="0.7.0"
SHA512="1b5331f021ae57d36bd0d6fdf6ec7fbc025eebfdb3a76ec8ffdc751d2a1f13ab490979cb3c21ee7f03ec3a3ec58aab7d176ae4d722f16ec68052914e8cbead97"
URL="https://registry.npmjs.org/cdp-wasm/-/cdp-wasm-${VERSION}.tgz"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${ROOT}/app/static/vendor/cdp-wasm-${VERSION}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "fetching ${URL}"
curl -fsSL -o "${TMP}/cdp-wasm-${VERSION}.tgz" "$URL"
echo "${SHA512}  ${TMP}/cdp-wasm-${VERSION}.tgz" | sha512sum -c -

mkdir -p "${TARGET}"
tar xzf "${TMP}/cdp-wasm-${VERSION}.tgz" -C "$TMP"
# Runtime subset only: sources + wasm build + licence. man/docs stay out.
cp -r "${TMP}/package/src" "${TARGET}/src"
cp -r "${TMP}/package/wasm" "${TARGET}/wasm"
cp "${TMP}/package/LICENSE" "${TARGET}/LICENSE"
cp "${TMP}/package/package.json" "${TARGET}/package.json"

FILES=$(find "${TARGET}" -type f | wc -l)
SIZE=$(du -sh "${TARGET}" | cut -f1)
echo "vendored ${TARGET} (${FILES} files, ${SIZE})"
echo "verify: curl -sI http://127.0.0.1:24590/vendor/cdp-wasm-${VERSION}/wasm/manifest.json"
