#!/bin/bash
# Post-edit hook: builds the modified contract if a file in contracts/ was edited.
# Reads JSON input from stdin (Claude Code hook protocol).

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty')

# Only trigger for files inside contracts/
if [[ -z "$FILE_PATH" ]] || [[ "$FILE_PATH" != *"/contracts/"* ]]; then
  exit 0
fi

# Find the contract directory (parent of src/)
CONTRACT_DIR=$(echo "$FILE_PATH" | sed 's|/src/.*||')
CARGO_TOML="$CONTRACT_DIR/Cargo.toml"

if [[ ! -f "$CARGO_TOML" ]]; then
  exit 0
fi

# Run cargo miden build
if cargo miden build --manifest-path "$CARGO_TOML" --release 2>&1; then
  echo '{"hookSpecificOutput": {"additionalContext": "Contract build succeeded"}}'
  exit 0
else
  BUILD_OUTPUT=$(cargo miden build --manifest-path "$CARGO_TOML" --release 2>&1 | tail -20)
  echo "{\"hookSpecificOutput\": {\"additionalContext\": \"Contract build FAILED. Fix compilation errors before continuing.\n$BUILD_OUTPUT\"}}"
  exit 2
fi
