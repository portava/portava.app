#!/usr/bin/env bash

set -Eeuo pipefail

cd "${1:-.}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

RAW="$TMP/raw.tsv"
REFERENCED="$TMP/referenced.txt"
AVAILABLE="$TMP/available.txt"
MISSING="$TMP/missing.txt"
IGNORE="$TMP/ignore.txt"

touch "$RAW" "$REFERENCED" "$AVAILABLE" "$MISSING"

echo
echo "Travel Buddy Runtime Environment Audit v2"
echo "Project: $(pwd)"
echo

SCAN_PATHS=()

for path in \
  app \
  apps \
  src \
  api \
  server \
  client \
  mobile \
  web \
  packages \
  lib \
  shared \
  services \
  workers \
  supabase/functions \
  scripts \
  app.config.js \
  app.config.ts \
  app.json \
  eas.json \
  expo-env.d.ts \
  vite.config.js \
  vite.config.ts \
  package.json
do
  [[ -e "$path" ]] && SCAN_PATHS+=("$path")
done

if [[ ${#SCAN_PATHS[@]} -eq 0 ]]; then
  echo "No recognized application paths found."
  echo "Run this from the project root."
  exit 1
fi

echo "Scanning:"
printf '  - %s\n' "${SCAN_PATHS[@]}"
echo

# Exact platform/build variables to ignore.
cat > "$IGNORE" <<'EOF'
ANDROID_HOME
ANDROID_SDK_ROOT
APPDATA
AWS_EXECUTION_ENV
BROWSER
CI
COLUMNS
DEBUG
EDITOR
EXPO_DEBUG
EXPO_DEV_SERVER_ORIGIN
EXPO_OFFLINE
EXPO_OS
EXPO_PACKAGER_PROXY_URL
EXPO_PROJECT_ROOT
EXPO_ROUTER_ABS_APP_ROOT
EXPO_ROUTER_APP_ROOT
EXPO_ROUTER_IMPORT_MODE
EXPO_SERVER
EXPO_TOKEN
FORCE_COLOR
HOME
HOMEDRIVE
HOMEPATH
HOST
HOSTNAME
JEST_WORKER_ID
JAVA_HOME
LINES
LOCALAPPDATA
LOGNAME
NODE_DEBUG
NODE_ENV
NODE_OPTIONS
NODE_PATH
NODE_TEST_WORKER_ID
NODE_V8_COVERAGE
NO_COLOR
OLDPWD
OSTYPE
PATH
PATHEXT
PORT
PWD
RCT_METRO_PORT
SHELL
SystemRoot
SYSTEMROOT
TEMP
TERM
TERM_PROGRAM
TMP
TMPDIR
TZ
USER
USERNAME
USERPROFILE
VERCEL_ENV
VISUAL
windir
EOF

sort -u "$IGNORE" -o "$IGNORE"

extract_matches() {
  local file="$1"
  local line="$2"
  local text="$3"

  printf '%s\n' "$text" |
    grep -oE 'process\.env\.[A-Za-z_][A-Za-z0-9_]*' |
    sed 's/process\.env\.//' |
    while read -r name; do
      printf '%s\t%s:%s\t%s\n' "$name" "$file" "$line" "$text"
    done || true

  printf '%s\n' "$text" |
    grep -oE "process\.env\[['\"][A-Za-z_][A-Za-z0-9_]*['\"]\]" |
    sed -E "s/process\.env\[['\"]([^'\"]+)['\"]\]/\1/" |
    while read -r name; do
      printf '%s\t%s:%s\t%s\n' "$name" "$file" "$line" "$text"
    done || true

  printf '%s\n' "$text" |
    grep -oE 'import\.meta\.env\.[A-Za-z_][A-Za-z0-9_]*' |
    sed 's/import\.meta\.env\.//' |
    while read -r name; do
      printf '%s\t%s:%s\t%s\n' "$name" "$file" "$line" "$text"
    done || true

  printf '%s\n' "$text" |
    grep -oE "Deno\.env\.get\(['\"][A-Za-z_][A-Za-z0-9_]*['\"]\)" |
    sed -E "s/Deno\.env\.get\(['\"]([^'\"]+)['\"]\)/\1/" |
    while read -r name; do
      printf '%s\t%s:%s\t%s\n' "$name" "$file" "$line" "$text"
    done || true

  printf '%s\n' "$text" |
    grep -oE 'Bun\.env\.[A-Za-z_][A-Za-z0-9_]*' |
    sed 's/Bun\.env\.//' |
    while read -r name; do
      printf '%s\t%s:%s\t%s\n' "$name" "$file" "$line" "$text"
    done || true
}

if command -v rg >/dev/null 2>&1; then
  rg \
    --line-number \
    --no-heading \
    --color never \
    --glob '!node_modules/**' \
    --glob '!.git/**' \
    --glob '!.expo/**' \
    --glob '!dist/**' \
    --glob '!build/**' \
    --glob '!coverage/**' \
    --glob '!generated/**' \
    --glob '!__generated__/**' \
    --glob '!fixtures/**' \
    --glob '!__fixtures__/**' \
    --glob '!__tests__/**' \
    --glob '!*.test.*' \
    --glob '!*.spec.*' \
    --glob '!*.stories.*' \
    --glob '!*.snap' \
    --glob '!*.map' \
    --glob '!*.lock' \
    --glob '!package-lock.json' \
    --glob '!pnpm-lock.yaml' \
    --glob '!yarn.lock' \
    'process\.env|import\.meta\.env|Deno\.env\.get|Bun\.env' \
    "${SCAN_PATHS[@]}" 2>/dev/null |
  while IFS=: read -r file line text; do
    extract_matches "$file" "$line" "$text"
  done > "$RAW"
else
  grep \
    -RInE \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=.expo \
    --exclude-dir=dist \
    --exclude-dir=build \
    --exclude-dir=coverage \
    --exclude-dir=generated \
    --exclude-dir=__generated__ \
    --exclude-dir=fixtures \
    --exclude-dir=__fixtures__ \
    --exclude-dir=__tests__ \
    --exclude='*.test.*' \
    --exclude='*.spec.*' \
    --exclude='*.stories.*' \
    --exclude='*.snap' \
    --exclude='*.map' \
    --exclude='*.lock' \
    --exclude='package-lock.json' \
    --exclude='pnpm-lock.yaml' \
    --exclude='yarn.lock' \
    'process\.env|import\.meta\.env|Deno\.env\.get|Bun\.env' \
    "${SCAN_PATHS[@]}" 2>/dev/null |
  while IFS=: read -r file line text; do
    extract_matches "$file" "$line" "$text"
  done > "$RAW" || true
fi

awk -F '\t' '{print $1}' "$RAW" |
  grep -E '^[A-Za-z_][A-Za-z0-9_]*$' |
  sort -u > "$TMP/all-referenced.txt" || true

# Remove exact ignored names.
comm -23 "$TMP/all-referenced.txt" "$IGNORE" > "$TMP/after-exact-ignore.txt"

# Remove families of platform/tooling variables.
grep -Ev \
  '^(npm_|NPM_|BABEL_|BROWSERSLIST_|CHOKIDAR_|DOTENV_CONFIG_|VSCODE_|RCT_|REACT_NATIVE_|WEBPACK_|ESBUILD_|TSC_|TSX_|PRETTIER_)' \
  "$TMP/after-exact-ignore.txt" > "$REFERENCED" || true

# Current shell environment.
env |
  sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' \
  >> "$AVAILABLE"

ENV_FILES=(
  .env
  .env.local
  .env.development
  .env.development.local
  .env.production
  .env.production.local
  .env.test
  .env.test.local
  app/.env
  app/.env.local
  apps/mobile/.env
  apps/mobile/.env.local
  apps/web/.env
  apps/web/.env.local
  mobile/.env
  mobile/.env.local
  server/.env
  server/.env.local
)

for file in "${ENV_FILES[@]}"; do
  if [[ -f "$file" ]]; then
    sed -nE \
      's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' \
      "$file" >> "$AVAILABLE"
  fi
done

sort -u "$AVAILABLE" -o "$AVAILABLE"
comm -23 "$REFERENCED" "$AVAILABLE" > "$MISSING"

echo "Referenced application variables: $(wc -l < "$REFERENCED" | tr -d ' ')"
echo "Missing variables:                $(wc -l < "$MISSING" | tr -d ' ')"
echo

if [[ ! -s "$MISSING" ]]; then
  echo "No missing application environment variables were detected."
else
  echo "MISSING APPLICATION VARIABLES"
  echo "============================="

  while IFS= read -r name; do
    echo
    echo "  $name"

    awk -F '\t' -v env="$name" '
      $1 == env {
        print "    " $2
      }
    ' "$RAW" | sort -u | head -20
  done < "$MISSING"
fi

echo
echo "Blank template: .env.missing.runtime"

{
  echo "# Generated by audit-runtime-env-v2.sh"
  echo "# Add only variables genuinely needed by your runtime."
  echo

  while IFS= read -r name; do
    printf '%s=\n' "$name"
  done < "$MISSING"
} > .env.missing.runtime

echo
echo "Environment files found:"

found=false

for file in "${ENV_FILES[@]}"; do
  if [[ -f "$file" ]]; then
    echo "  ✓ $file"
    found=true
  fi
done

if [[ "$found" == false ]]; then
  echo "  None"
fi

echo
echo "Direct environment references found: $(wc -l < "$RAW" | tr -d ' ')"
echo "Audit complete."
