#!/usr/bin/env bash
# Build the single supported Linux release format: an x86_64 tar.gz archive.
set -Eeuo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  printf 'Run this script on Linux x86_64.\n' >&2
  exit 1
fi
if [[ "$(bun --version)" != 1.4.5 ]]; then
  printf 'Bun 1.4.5 is required, matching the Windows and Docker build.\n' >&2
  exit 1
fi

cd "$project_root"
version="$(bun -e 'console.log((await Bun.file("alpha-manifest.json").json()).version)')"
output_dir="${1:-$project_root/../release-$version}"
mkdir -p "$output_dir"
output_dir="$(cd -- "$output_dir" && pwd)"
package_root="$(mktemp -d "${TMPDIR:-/tmp}/rikkahub-linux-package.XXXXXX")"
trap 'rm -rf -- "$package_root"' EXIT

(
  cd pc-server
  bun run scripts/check-version-sync.ts
  bun install --frozen-lockfile
  bun run scripts/prepare-linux-build.ts
)
(
  cd web-ui
  bun install --frozen-lockfile
  bun run build
)
(
  cd pc-server
  bun run compile:linux
)

package_dir="$package_root/rikkahub-pc"
mkdir -p "$package_dir/web-ui/build" "$package_dir/licenses"
install -m 0755 dist/rikkahub-pc "$package_dir/rikkahub-pc"
cp -R web-ui/build/client "$package_dir/web-ui/build/client"
cp -R fonts icons "$package_dir/"
cp docs/LINUX.md "$package_dir/README.md"
cp LICENSE LICENSE-AGPL-3.0.txt "$package_dir/"
cp vendor/pi-auth/LICENSE "$package_dir/licenses/pi-auth-MIT.txt"
test -s "$package_dir/web-ui/build/client/index.html"

archive="$output_dir/Rikkahub_${version}_linux_x64.tar.gz"
tar -C "$package_root" -czf "$archive.tmp" rikkahub-pc/
tar -tzf "$archive.tmp" >/dev/null
mv -- "$archive.tmp" "$archive"
printf 'Built %s\n' "$archive"
sha256sum "$archive"
