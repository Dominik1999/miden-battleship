#!/bin/bash
# Post-edit hook: runs tests affected by changes since last commit.
# Only triggers for .ts/.tsx files in src/. Uses vitest --changed for detection.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty')

# Only trigger for TypeScript/React files in src/
if [[ -z "$FILE_PATH" ]] || [[ "$FILE_PATH" != *.ts && "$FILE_PATH" != *.tsx ]]; then
  exit 0
fi

if [[ "$FILE_PATH" != *"/src/"* ]]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" || exit 0

# Run tests affected by uncommitted changes (non-watch mode, no coverage)
TEST_OUTPUT=$(npx vitest --changed --run 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo '{"hookSpecificOutput": {"additionalContext": "Affected tests passed"}}'
  exit 0
else
  # Show last 30 lines of test output for context
  TRIMMED=$(echo "$TEST_OUTPUT" | tail -30)
  echo "{\"hookSpecificOutput\": {\"additionalContext\": \"Affected tests FAILED. Fix failing tests before continuing.\n$TRIMMED\"}}"
  exit 2
fi
