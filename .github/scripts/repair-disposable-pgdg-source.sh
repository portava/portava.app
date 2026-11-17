#!/bin/sh
# postgis/postgis:16-3.4 inherits Debian Bullseye and its legacy pgdg.list.
# PGDG retired that suite in September 2026. Use its official signed archive
# only in this disposable fixture; preserve the image and repository trust options.
# https://www.postgresql.org/message-id/apWm8-epjef2xpkM%40msg.df7cb.de
# https://apt-archive.postgresql.org/
set -eu

config_root=${1:-/etc}
[ -f "$config_root/os-release" ] || { echo 'Missing fixture OS release' >&2; exit 1; }
platform_id=$(sed -n 's/^ID=//p' "$config_root/os-release" | tr -d '"')
platform_codename=$(sed -n 's/^VERSION_CODENAME=//p' "$config_root/os-release" | tr -d '"')
[ "$platform_id:$platform_codename" = 'debian:bullseye' ] || exit 0

source_file="$config_root/apt/sources.list.d/pgdg.list"
[ -f "$source_file" ] || { echo 'Expected Bullseye fixture pgdg.list is missing' >&2; exit 1; }
staged_file=$(mktemp "$source_file.tmp.XXXXXX")
trap 'rm -f "$staged_file"' EXIT HUP INT TERM

# Match an active Bullseye PGDG line and the exact repository URI. Leave other
# suites, commented lines, Signed-By paths, and every signature setting intact.
awk '
  /^[ \t]*deb(-src)?[ \t]/ && /[ \t]bullseye-pgdg([ \t]|$)/ &&
  /[ \t]https?:\/\/apt[.]postgresql[.]org\/pub\/repos\/apt\/?([ \t]|$)/ {
    sub(/https?:\/\/apt[.]postgresql[.]org\/pub\/repos\/apt/, "https://apt-archive.postgresql.org/pub/repos/apt")
  }
  { print }
' "$source_file" > "$staged_file"

# Fail before replacing anything if the pinned image's expected source shape
# changed. Never invent a repository or disable authentication to get past apt.
grep -Eq '^[[:space:]]*deb(-src)?[[:space:]]+(\[[^]]*\][[:space:]]+)?https://apt-archive[.]postgresql[.]org/pub/repos/apt/?[[:space:]]+bullseye-pgdg([[:space:]]|$)' "$staged_file" || {
  echo 'No supported active Bullseye PGDG source found' >&2
  exit 1
}
cat "$staged_file" > "$source_file"
