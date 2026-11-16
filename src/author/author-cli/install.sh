#!/bin/sh
# Install the s2s author CLI from a release tarball.
#
#   curl -fsSL https://raw.githubusercontent.com/Incredibly-Neutral/Soul2Soul/main/src/author/author-cli/install.sh | sh
#   sh install.sh 0.2.0          # a specific version instead of the latest tag
#   sh install.sh                # in a directory holding the tarball: installs that
#
# Env:
#   S2S_VERSION    version to install (overrides the latest-tag lookup)
#   S2S_PREFIX     install prefix, default ~/.local  →  <prefix>/bin/s2s,
#                                                        <prefix>/lib/s2s/{cli.cjs,defaults.json}
#   S2S_BASE_URL   download URL or directory, for a mirror or a local copy
#                  (`file:///path`, or just the path)
#
# The CLI is one CJS file plus `defaults.json`; there is nothing to compile and
# no dependencies to resolve. node 20 or newer is required to run it, checked
# here so the failure is a sentence rather than a stack trace.
#
# Unix only. On Windows, use WSL or copy dist/cli.cjs and dist/defaults.json
# from a build.

set -eu

REPO='Incredibly-Neutral/Soul2Soul'
MIN_NODE=20
PREFIX="${S2S_PREFIX:-$HOME/.local}"
VERSION="${1:-${S2S_VERSION:-}}"

die() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

fetch() {
  # fetch <url> <out-file>
  if have curl; then
    curl -fsSL "$1" -o "$2"
  elif have wget; then
    wget -qO "$2" "$1"
  else
    die 'curl or wget is needed to download the release'
  fi
}

# The tag names the file, so the latest version has to be resolved before the
# URL can be built: follow the /releases/latest redirect and take the last path
# segment. A 404 here means no release is published yet.
latest_version() {
  if ! have curl; then
    die 'pass a version (install.sh <version>) when curl is unavailable'
  fi
  effective=$(curl -fsSIL -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest" 2>/dev/null) ||
    die "no published release found for $REPO — pass a version instead"
  # No release yet: GitHub redirects to /releases, whose last segment is not a
  # version. Anything that does not look like one is a 404 in disguise.
  case "${effective##*/}" in
    v[0-9]*) printf '%s\n' "${effective##*/}" | sed 's/^v//' ;;
    *) die "no published release found for $REPO — pass a version instead" ;;
  esac
}

have node || die "node is required (${MIN_NODE}+); install it first, or see https://nodejs.org"

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$node_major" -ge "$MIN_NODE" ] 2>/dev/null ||
  die "node ${MIN_NODE}+ is required, this is $(node -v 2>/dev/null || echo 'unknown')"

# An archive in the current directory is the one to install, and its name is the
# version: this is what copying a build to another machine leaves behind, and it
# saves passing both a version and a base URL by hand.
local_tarball() {
  file=''
  count=0
  for candidate in ./s2s-*-node.tar.gz; do
    [ -f "$candidate" ] || continue
    file="${candidate#./}"
    count=$((count + 1))
  done
  [ "$count" -le 1 ] ||
    die "several release tarballs in $PWD — pass the version: install.sh <version>"
  printf '%s\n' "$file"
}

local_file=$(local_tarball)

if [ -z "$VERSION" ] && [ -n "$local_file" ]; then
  VERSION="${local_file#s2s-}"
  VERSION="${VERSION%-node.tar.gz}"
fi
[ -n "$VERSION" ] || VERSION=$(latest_version)
case "$VERSION" in
  [0-9]*) ;;
  *) die "\"$VERSION\" is not a version — pass one, e.g. install.sh 0.1.0" ;;
esac

name="s2s-${VERSION}-node"

# Most specific source first: an explicit URL, a tarball beside this script,
# then the GitHub release for the tag.
if [ -n "${S2S_BASE_URL:-}" ]; then
  base="$S2S_BASE_URL"
  case "$base" in
    /*) base="file://$base" ;;
  esac
elif [ "$local_file" = "$name.tar.gz" ]; then
  base="file://$PWD"
  printf 'install: using %s from %s\n' "$local_file" "$PWD"
else
  base="https://github.com/$REPO/releases/download/v${VERSION}"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

printf 'install: fetching %s\n' "$name.tar.gz"
fetch "$base/$name.tar.gz" "$tmp/$name.tar.gz" ||
  die "download failed: $base/$name.tar.gz"
fetch "$base/$name.tar.gz.sha256" "$tmp/$name.tar.gz.sha256" ||
  die "download failed: $base/$name.tar.gz.sha256 (a published release ships both files)"

if have sha256sum; then
  (cd "$tmp" && sha256sum -c "$name.tar.gz.sha256" >/dev/null) ||
    die 'checksum mismatch — the download is corrupt or was tampered with'
elif have shasum; then
  (cd "$tmp" && shasum -a 256 -c "$name.tar.gz.sha256" >/dev/null) ||
    die 'checksum mismatch — the download is corrupt or was tampered with'
else
  printf 'install: no sha256sum/shasum — skipping checksum verification\n' >&2
fi

lib="$PREFIX/lib/s2s"
mkdir -p "$lib" "$PREFIX/bin"
rm -f "$lib/cli.cjs" "$lib/defaults.json"
tar -xzf "$tmp/$name.tar.gz" -C "$lib"
chmod 755 "$lib/cli.cjs"

# A symlink, not a wrapper script: node resolves it, so `__dirname` stays the
# library directory and `defaults.json` is found beside the bundle.
ln -sf "$lib/cli.cjs" "$PREFIX/bin/s2s"

installed=$("$PREFIX/bin/s2s" --version 2>/dev/null) ||
  die "installed to $lib but it did not run"

printf 'install: %s\n' "$installed"
printf 'install: %s\n' "$PREFIX/bin/s2s"
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) printf 'install: add %s to PATH to run `s2s`\n' "$PREFIX/bin" ;;
esac
