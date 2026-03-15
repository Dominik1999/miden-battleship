#!/bin/bash
# Post-edit hook: runs TypeScript type checking when .ts/.tsx files in src/ are modified.
# Reads JSON input from stdin (Claude Code hook protocol).

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty')

# Only trigger for TypeScript/React files in src/
if [[ -z "$FILE_PATH" ]] || [[ "$FILE_PATH" != *.ts && "$FILE_PATH" != *.tsx ]]; then
  exit 0
fi

if [[ "$FILE_PATH" != *"/src/"* ]]; then
  exit 0
fi

# Run TypeScript type checking from project root
cd "$CLAUDE_PROJECT_DIR" || exit 0

if npx tsc -b --noEmit 2>&1; then
  echo '{"hookSpecificOutput": {"additionalContext": "TypeScript type check passed"}}'
  exit 0
else
  CHECK_OUTPUT=$(npx tsc -b --noEmit 2>&1 | tail -30)
  echo "{\"hookSpecificOutput\": {\"additionalContext\": \"TypeScript type check FAILED. Fix type errors before continuing.\n$CHECK_OUTPUT\"}}"
  exit 2
fi
