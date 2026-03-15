#!/bin/bash
# Post-edit hook: runs affected tests when a file in frontend-template/src/ is edited.
# Monorepo wrapper -- runs vitest from the frontend-template directory.

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

if npx vitest --changed --run 2>&1; then
  echo '{"hookSpecificOutput": {"additionalContext": "Affected tests passed"}}'
  exit 0
else
  TEST_OUTPUT=$(npx vitest --changed --run 2>&1 | tail -30)
  echo "{\"hookSpecificOutput\": {\"additionalContext\": \"Tests FAILED. Fix failing tests.\n$TEST_OUTPUT\"}}"
  exit 2
fi
