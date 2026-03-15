#!/bin/bash
# Validates that required .masp contract artifacts exist in public/packages/.
# Run before build or as a standalone check.

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || cd "$(dirname "$0")/../.." || exit 1

PACKAGES_DIR="public/packages"
ERRORS=0

if [ ! -d "$PACKAGES_DIR" ]; then
  echo "ERROR: $PACKAGES_DIR directory does not exist"
  exit 1
fi

# Check for .masp files
MASP_FILES=$(find "$PACKAGES_DIR" -name "*.masp" 2>/dev/null)

if [ -z "$MASP_FILES" ]; then
  echo "ERROR: No .masp files found in $PACKAGES_DIR"
  echo "Run 'cargo miden build' in the contract project and copy .masp files here."
  exit 1
fi

echo "Contract artifacts in $PACKAGES_DIR:"
while IFS= read -r file; do
  SIZE=$(wc -c < "$file" | tr -d ' ')
  if [ "$SIZE" -eq 0 ]; then
    echo "  ERROR: $file is empty (0 bytes)"
    ERRORS=$((ERRORS + 1))
  elif [ "$SIZE" -lt 100 ]; then
    echo "  WARN:  $file is suspiciously small ($SIZE bytes)"
  else
    echo "  OK:    $file ($SIZE bytes)"
  fi
done <<< "$MASP_FILES"

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "$ERRORS artifact(s) have errors. Rebuild contracts with 'cargo miden build'."
  exit 1
fi

echo ""
echo "All artifacts valid."
exit 0
