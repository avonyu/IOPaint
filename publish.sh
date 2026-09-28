#!/usr/bin/env bash
# Build and package IOPaint for PyPI release.
#
# Usage:
#   bash publish.sh             # build wheel + sdist into ./dist
#   bash publish.sh --upload    # build, then upload to PyPI via twine
#   bash publish.sh --test      # build, then upload to TestPyPI
#
# Requires: uv, nodejs/npm

set -euo pipefail

# Resolve project root regardless of where the script is invoked from
cd "$(dirname "$0")"

# Ensure uv is on PATH (Git Bash on Windows often misses it).
# Try common install locations before giving up.
if ! command -v uv >/dev/null 2>&1; then
  for candidate in \
    "$HOME/.cargo/bin/uv" \
    "$HOME/.local/bin/uv" \
    "/usr/local/bin/uv" \
    "/opt/homebrew/bin/uv"; do
    if [ -x "$candidate" ]; then
      export PATH="$(dirname "$candidate"):$PATH"
      break
    fi
  done
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "✗ 'uv' is required but not found on PATH." >&2
  echo "  Install: https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

UPLOAD_TARGET=""

for arg in "$@"; do
  case "$arg" in
    --upload) UPLOAD_TARGET="pypi" ;;
    --test)   UPLOAD_TARGET="testpypi" ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

echo "▶ 1/6 Sync Python deps (incl. dev group: wheel, twine)"
uv sync --group dev

echo "▶ 2/6 Build frontend (web_app/dist)"
pushd ./web_app >/dev/null
rm -rf dist
npm run build
popd >/dev/null

echo "▶ 3/6 Copy frontend dist into Python package"
rm -rf ./iopaint/web_app
cp -R web_app/dist ./iopaint/web_app

echo "▶ 4/6 Clean previous build artifacts"
rm -rf dist build iopaint.egg-info

echo "▶ 5/6 Build wheel + sdist via uv (PEP 517)"
uv build

echo ""
echo "✓ Artifacts:"
ls -lh dist/

if [ -n "$UPLOAD_TARGET" ]; then
  echo ""
  echo "▶ 6/6 Uploading to ${UPLOAD_TARGET}"
  case "$UPLOAD_TARGET" in
    pypi)     twine upload dist/* ;;
    testpypi) twine upload --repository testpypi dist/* ;;
  esac
  echo "✓ Upload complete"
else
  echo ""
  echo "Next:"
  echo "  twine upload dist/*                            # upload to PyPI"
  echo "  twine upload --repository testpypi dist/*      # dry-run via TestPyPI"
fi