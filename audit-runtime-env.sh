#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="${1:-.}"
cd "$ROOT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

RAW="$TMP/raw.tsv"
REFERENCED="$TMP/referenced.txt"
AVAILABLE="$TMP/available.txt"
MISSING="$TMP/missing.txt"
REQUIRED="$TMP/required.txt"
OPTIONAL="$TMP/optional.txt"

touch "$RAW" "$REFERENCED" "$AVAILABLE" "$MISSING" "$REQUIRED" "$OPTIONAL"

echo
echo "Travel Buddy Runtime Environment Audit"
echo "Project: $(pwd)"
echo

# Only scan application-owned files.
SCAN_PATHS=()

for path in \
  app \
  apps \
  api \
  src \
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
  config \
  expo-env.d.ts \
  app.config.js \
  app.config.ts \
  app.json \
  eas.json \
  vite.config.js \
  vite.config.ts \
  metro.config.js \
  metro.config.ts \
  package.json
do
  [[ -e "$path" ]] && SCAN_PATHS+=("$path")
done

if [[ ${#SCAN_PATHS[@]} -eq 0 ]]; then
  echo "No standard application directories were found."
  echo "Run this command from the project root."
  exit 1
fi

echo "Scanning:"
printf '  - %s\n' "${SCAN_PATHS[@]}"
echo

# Files/directories that should not determine production secrets.
EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=.git
  --exclude-dir=.expo
  --exclude-dir=.next
  --exclude-dir=.turbo
  --exclude-dir=.cache
  --exclude-dir=dist
  --exclude-dir=build
  --exclude-dir=coverage
  --exclude-dir=vendor
  --exclude-dir=generated
  --exclude-dir=__generated__
  --exclude-dir=fixtures
  --exclude-dir=fixture
  --exclude-dir=examples
  --exclude-dir=example
  --exclude-dir=snapshots
  --exclude-dir=__snapshots__
  --exclude-dir=test-results
  --exclude='*.lock'
  --exclude='package-lock.json'
  --exclude='pnpm-lock.yaml'
  --exclude='yarn.lock'
  --exclude='bun.lock'
  --exclude='bun.lockb'
  --exclude='*.map'
  --exclude='*.snap'
  --exclude='*.min.js'
  --exclude='*.test.*'
  --exclude='*.spec.*'
  --exclude='*.stories.*'
  --exclude='*.fixture.*'
  --exclude='*.mock.*'
)

# Search only text/code/config formats that may be application-owned.
INCLUDES=(
  --include='*.ts'
  --include='*.tsx'
  --include='*.js'
  --include='*.jsx'
  --include='*.mjs'
  --include='*.cjs'
  --include='*.mts'
  --include='*.cts'
  --include='*.json'
  --include='*.yaml'
  --include='*.yml'
  --include='*.toml'
  --include='*.sh'
  --include='*.py'
)

scan_pattern() {
  local pattern="$1"

  grep -RInE \
    "${EXCLUDES[@]}" \
    "${INCLUDES[@]}" \
    "$pattern" \
    "${SCAN_PATHS[@]}" 2>/dev/null || true
}

# process.env.NAME
scan_pattern 'process\.env\.[A-Za-z_][A-Za-z0-9_]*' \
  | while IFS=: read -r file line text; do
      printf '%s\n' "$text" \
        | grep -oE 'process\.env\.[A-Za-z_][A-Za-z0-9_]*' \
        | sed 's/process\.env\.//' \
        | while read -r name; do
            printf '%s\t%s:%s\t%s\n' "$name" "$file" "$line" "$text"
          done
    done >> "$RAW"

# process.env["NAME"] / process.env['NAME']
scan_pattern "process\.env\[['\"][A-Za-z_][A-Za-z0-9_]*['\"]\]" \
  | while IFS=: read -r file line text; do
      printf '%s\n' "$text" \
        | grep -oE "process\.env\[['\"][A-Za-z_][A-Za-z0-9_]*['\"]\]" \
        | sed -E "s/process\.env\[['\"]([^'\"]+)['\"]\]/\1/" \
        | while read -r name; do
            printf '%s\t%s:%s\t%s\n' "$name" "$file" "$line" "$text"
          done
    done >> "$RAW"

# import.meta.env.NAME
scan_pattern 'import\.meta\.env\.[A-Za-z_][A-Za-z0-9_]*' \
  | while IFS=: read -r file line text; do
      printf '%s\n' "$text" \
        | grep -oE 'import\.meta\.env\.[A-Za-z_][A-Za-z0-9_]*' \
        | sed 's/import\.meta\.env\.//' \
        | while read -r name; do
            printf '%s\t%s:%s\t%s\n' "$name" "$file" "$line" "$text"
          done
    done >> "$RAW"

# Deno.env.get("NAME")
scan_pattern "Deno\.env\.get\(['\"][A-Za-z_][A-Za-z0-9_]*['\"]\)" \
  | while IFS=: read -r file line text; do
      printf '%s\n' "$text" \
        | grep -oE "Deno\.env\.get\(['\"][A-Za-z_][A-Za-z0-9_]*['\"]\)" \
        | sed -E "s/Deno\.env\.get\(['\"]([^'\"]+)['\"]\)/\1/" \
        | while read -r name; do
            printf '%s\t%s:%s\t%s\n' "$name" "$file" "$line" "$text"
          done
    done >> "$RAW"

# Bun.env.NAME
scan_pattern 'Bun\.env\.[A-Za-z_][A-Za-z0-9_]*' \
  | while IFS=: read -r file line text; do
      printf '%s\n' "$text" \
        | grep -oE 'Bun\.env\.[A-Za-z_][A-Za-z0-9_]*' \
        | sed 's/Bun\.env\.//' \
        | while read -r name; do
            printf '%s\t%s:%s\t%s\n' "$name" "$file" "$line" "$text"
          done
    done >> "$RAW"

# Python os.getenv("NAME") and os.environ["NAME"]
scan_pattern "os\.(getenv|environ)" \
  | while IFS=: read -r file line text; do
      printf '%s\n' "$text" \
        | grep -oE "os\.getenv\(['\"][A-Za-z_][A-Za-z0-9_]*['\"]" \
        | sed -E "s/os\.getenv\(['\"]([^'\"]+)['\"]/\1/" \
        | while read -r name; do
            printf '%s\t%s:%s\t%s\n' "$name" "$file" "$line" "$text"
          done

      printf '%s\n' "$text" \
        | grep -oE "os\.environ\[['\"][A-Za-z_][A-Za-z0-9_]*['\"]\]" \
        | sed -E "s/os\.environ\[['\"]([^'\"]+)['\"]\]/\1/" \
        | while read -r name; do
            printf '%s\t%s:%s\t%s\n' "$name" "$file" "$line" "$text"
          done
    done >> "$RAW"

# Remove obvious platform/build variables that are not application configuration.
IGNORE_REGEX='^(
NODE_ENV|
PORT|
HOST|
HOSTNAME|
PWD|
OLDPWD|
HOME|
PATH|
SHELL|
USER|
USERNAME|
LOGNAME|
TERM|
TERM_PROGRAM|
CI|
TZ|
TMP|
TEMP|
TMPDIR|
EDITOR|
VISUAL|
FORCE_COLOR|
NO_COLOR|
DEBUG|
BROWSER|
COLUMNS|
LINES|
APPDATA|
LOCALAPPDATA|
LocalAppData|
USERPROFILE|
HOMEDRIVE|
HOMEPATH|
SystemRoot|
SYSTEMROOT|
windir|
comspec|
OSTYPE|
PATHEXT|
ANDROID_HOME|
ANDROID_SDK_ROOT|
JAVA_HOME|
npm_.*|
NPM_.*|
NODE_OPTIONS|
NODE_PATH|
NODE_DEBUG|
NODE_V8_COVERAGE|
JEST_WORKER_ID|
NODE_TEST_WORKER_ID|
VSCODE_.*|
BABEL_.*|
BROWSERSLIST_.*|
CHOKIDAR_.*|
DOTENV_CONFIG_.*|
EXPO_ROUTER_.*|
EXPO_PROJECT_ROOT|
EXPO_DEBUG|
EXPO_OFFLINE|
EXPO_OS|
EXPO_SERVER|
EXPO_TOKEN|
EXPO_DEV_SERVER_ORIGIN|
EXPO_PACKAGER_PROXY_URL|
EXPO_USE_METRO_REQUIRE|
RCT_.*|
REACT_NATIVE_.*|
WEBPACK_.*|
ESBUILD_.*|
TSC_.*|
TSX_.*|
PRETTIER_.*|
VERCEL_ENV|
AWS_EXECUTION_ENV
)$'

awk -F '\t' '{print $1}' "$RAW" \
  | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' \
  | grep -Ev "$IGNORE_REGEX" \
  | sort -u > "$REFERENCED" || true

# Load names available in shell and real environment files.
env | sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' >> "$AVAILABLE"

REAL_ENV_FILES=(
  .env
  .env.local
  .env.development
  .env.development.local
  .env.production
  .env.production.local
  .env.test
  .env.test.local
  apps/mobile/.env
  apps/mobile/.env.local
  apps/web/.env
  apps/web/.env.local
  mobile/.env
  mobile/.env.local
  server/.env
  server/.env.local
)

for file in "${REAL_ENV_FILES[@]}"; do
  if [[ -f "$file" ]]; then
    sed -nE \
      's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' \
      "$file" >> "$AVAILABLE"
  fi
done

sort -u "$AVAILABLE" -o "$AVAILABLE"
comm -23 "$REFERENCED" "$AVAILABLE" > "$MISSING"

# Classify lines with obvious fallbacks as optional.
while IFS= read -r name; do
  [[ -z "$name" ]] && continue

  references="$(
    awk -F '\t' -v env="$name" '$1 == env {print $3}' "$RAW" || true
  )"

  if printf '%s\n' "$references" | grep -Eq \
    "(\|\||\?\?|default|fallback|NODE_ENV|===?[[:space:]]*['\"]test|!==?[[:space:]]*['\"]production)"
  then
    echo "$name" >> "$OPTIONAL"
  else
    echo "$name" >> "$REQUIRED"
  fi
done < "$MISSING"

sort -u "$REQUIRED" -o "$REQUIRED"
sort -u "$OPTIONAL" -o "$OPTIONAL"

print_locations() {
  local name="$1"

  awk -F '\t' -v env="$name" '
    $1 == env {
      print "      " $2
    }
  ' "$RAW" | sort -u | head -10
}

echo "Referenced application variables: $(wc -l < "$REFERENCED" | tr -d ' ')"
echo "Missing variables:                $(wc -l < "$MISSING" | tr -d ' ')"
echo

if [[ -s "$REQUIRED" ]]; then
  echo "LIKELY REQUIRED"
  echo "==============="

  while IFS= read -r name; do
    echo
    echo "  $name"
    print_locations "$name"
  done < "$REQUIRED"
else
  echo "No clearly required variables appear to be missing."
fi

if [[ -s "$OPTIONAL" ]]; then
  echo
  echo "OPTIONAL OR HAS A FALLBACK"
  echo "=========================="

  while IFS= read -r name; do
    echo
    echo "  $name"
    print_locations "$name"
  done < "$OPTIONAL"
fi

echo
echo "SUSPICIOUS GENERIC VARIABLES"
echo "============================"

grep -E \
  '^(API_KEY|API_BASE_URL|BASE_URL|ACCESS_TOKEN|ACCESS_TOKEN_SECRET|CONSUMER_KEY|CONSUMER_SECRET|VARIABLE|foo|HELLO)$' \
  "$REFERENCED" 2>/dev/null \
  | while IFS= read -r name; do
      echo
      echo "  $name"
      print_locations "$name"
    done || echo "  None"

echo
echo "Blank template written to: .env.missing.runtime"

{
  echo "# Generated by audit-runtime-env.sh"
  echo "# Review every variable before adding a value."
  echo

  if [[ -s "$REQUIRED" ]]; then
    echo "# Likely required"
    while IFS= read -r name; do
      printf '%s=\n' "$name"
    done < "$REQUIRED"
  fi

  if [[ -s "$OPTIONAL" ]]; then
    echo
    echo "# Optional or appears to have a fallback"
    while IFS= read -r name; do
      printf '# %s=\n' "$name"
    done < "$OPTIONAL"
  fi
} > .env.missing.runtime

echo
echo "Environment files currently present:"

found=false
for file in "${REAL_ENV_FILES[@]}"; do
  if [[ -f "$file" ]]; then
    echo "  ✓ $file"
    found=true
  fi
done

if [[ "$found" == false ]]; then
  echo "  None"
fi

echo
echo "Audit complete. No secret values were displayed."
