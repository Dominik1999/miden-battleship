#!/bin/bash
# Post-edit hook: runs TypeScript type check when a file in frontend-template/src/ is edited.
# Monorepo wrapper -- runs tsc from the frontend-template directory.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty')

# Only trigger for .ts/.tsx files inside frontend-template/src/
if [[ -z "$FILE_PATH" ]] || [[ "$FILE_PATH" != *"frontend-template/src/"* ]]; then
  exit 0
fi

if [[ "$FILE_PATH" != *.ts && "$FILE_PATH" != *.tsx ]]; then
  exit 0
fi

FRONTEND_DIR="$CLAUDE_PROJECT_DIR/frontend-template"

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  exit 0
fi

cd "$FRONTEND_DIR" || exit 0

if npx tsc -b --noEmit 2>&1; then
  echo '{"hookSpecificOutput": {"additionalContext": "TypeScript type check passed"}}'
  exit 0
else
  TS_OUTPUT=$(npx tsc -b --noEmit 2>&1 | tail -30)
  echo "{\"hookSpecificOutput\": {\"additionalContext\": \"TypeScript type check FAILED. Fix type errors before continuing.\n$TS_OUTPUT\"}}"
  exit 2
fi
