#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="${1:-.}"
cd "$ROOT_DIR"

echo "Travel Buddy — Missing Secrets Audit"
echo "Project: $(pwd)"
echo

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

REFERENCED="$TEMP_DIR/referenced.txt"
DECLARED="$TEMP_DIR/declared.txt"
AVAILABLE="$TEMP_DIR/available.txt"
MISSING="$TEMP_DIR/missing.txt"

touch "$REFERENCED" "$DECLARED" "$AVAILABLE" "$MISSING"

# Directories that should not be scanned.
EXCLUDES=(
  --exclude-dir=node_modules
  --exclude-dir=.git
  --exclude-dir=.next
  --exclude-dir=dist
  --exclude-dir=build
  --exclude-dir=coverage
  --exclude-dir=.expo
  --exclude-dir=android
  --exclude-dir=ios
  --exclude-dir=.turbo
  --exclude-dir=.cache
  --exclude-dir=vendor
)

echo "Scanning code for referenced environment variables..."

# process.env.VARIABLE
grep -RhoE "${EXCLUDES[@]}" \
  'process\.env\.[A-Za-z_][A-Za-z0-9_]*' . 2>/dev/null \
  | sed 's/^process\.env\.//' \
  >> "$REFERENCED" || true

# process.env["VARIABLE"] and process.env['VARIABLE']
grep -RhoE "${EXCLUDES[@]}" \
  "process\.env\[['\"][A-Za-z_][A-Za-z0-9_]*['\"]\]" . 2>/dev/null \
  | sed -E "s/process\.env\[['\"]([^'\"]+)['\"]\]/\1/" \
  >> "$REFERENCED" || true

# import.meta.env.VARIABLE
grep -RhoE "${EXCLUDES[@]}" \
  'import\.meta\.env\.[A-Za-z_][A-Za-z0-9_]*' . 2>/dev/null \
  | sed 's/^import\.meta\.env\.//' \
  >> "$REFERENCED" || true

# Deno.env.get("VARIABLE")
grep -RhoE "${EXCLUDES[@]}" \
  "Deno\.env\.get\(['\"][A-Za-z_][A-Za-z0-9_]*['\"]\)" . 2>/dev/null \
  | sed -E "s/Deno\.env\.get\(['\"]([^'\"]+)['\"]\)/\1/" \
  >> "$REFERENCED" || true

# Bun.env.VARIABLE
grep -RhoE "${EXCLUDES[@]}" \
  'Bun\.env\.[A-Za-z_][A-Za-z0-9_]*' . 2>/dev/null \
  | sed 's/^Bun\.env\.//' \
  >> "$REFERENCED" || true

# Python os.getenv("VARIABLE")
grep -RhoE "${EXCLUDES[@]}" \
  "os\.getenv\(['\"][A-Za-z_][A-Za-z0-9_]*['\"]" . 2>/dev/null \
  | sed -E "s/os\.getenv\(['\"]([^'\"]+)['\"]/\1/" \
  >> "$REFERENCED" || true

# Python os.environ["VARIABLE"]
grep -RhoE "${EXCLUDES[@]}" \
  "os\.environ\[['\"][A-Za-z_][A-Za-z0-9_]*['\"]\]" . 2>/dev/null \
  | sed -E "s/os\.environ\[['\"]([^'\"]+)['\"]\]/\1/" \
  >> "$REFERENCED" || true

# Read variable names declared in common env files.
ENV_FILES=(
  .env
  .env.local
  .env.development
  .env.development.local
  .env.production
  .env.production.local
  .env.test
  .env.test.local
  .env.example
  .env.sample
  .env.template
  .env.defaults
)

for file in "${ENV_FILES[@]}"; do
  if [[ -f "$file" ]]; then
    sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$file" \
      >> "$DECLARED"
  fi
done

# Include variables currently exported in the shell.
env | sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' >> "$AVAILABLE"

# Treat variables in actual local env files as available.
for file in \
  .env \
  .env.local \
  .env.development \
  .env.development.local \
  .env.production \
  .env.production.local \
  .env.test \
  .env.test.local
do
  if [[ -f "$file" ]]; then
    sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$file" \
      >> "$AVAILABLE"
  fi
done

sort -u "$REFERENCED" -o "$REFERENCED"
sort -u "$DECLARED" -o "$DECLARED"
sort -u "$AVAILABLE" -o "$AVAILABLE"

# Exclude common runtime variables that usually are not app secrets.
grep -Ev '^(NODE_ENV|PORT|HOST|PWD|HOME|PATH|SHELL|USER|TERM|CI|TZ|DEBUG)$' \
  "$REFERENCED" > "$TEMP_DIR/app-referenced.txt" || true

mv "$TEMP_DIR/app-referenced.txt" "$REFERENCED"

comm -23 "$REFERENCED" "$AVAILABLE" > "$MISSING"

echo
echo "Referenced by application: $(wc -l < "$REFERENCED" | tr -d ' ')"
echo "Available locally:         $(wc -l < "$AVAILABLE" | tr -d ' ')"
echo

if [[ ! -s "$MISSING" ]]; then
  echo "✅ No referenced environment variables appear to be missing."
else
  echo "❌ Missing environment variables:"
  echo
  sed 's/^/  - /' "$MISSING"

  echo
  echo "Add them to .env.local without committing the file:"
  echo

  while IFS= read -r variable; do
    printf '%s=\n' "$variable"
  done < "$MISSING"
fi

echo
echo "Environment files found:"
found_any=false

for file in "${ENV_FILES[@]}"; do
  if [[ -f "$file" ]]; then
    echo "  ✓ $file"
    found_any=true
  fi
done

if [[ "$found_any" == false ]]; then
  echo "  None"
fi

echo
echo "Potentially required by templates but not referenced directly in code:"

comm -23 "$DECLARED" "$AVAILABLE" > "$TEMP_DIR/template-missing.txt"

if [[ -s "$TEMP_DIR/template-missing.txt" ]]; then
  sed 's/^/  - /' "$TEMP_DIR/template-missing.txt"
else
  echo "  None"
fi

echo
echo "Security reminder: this audit prints names only, never secret values."
