#!/bin/bash
cd /home/kavia/workspace/code-generation/compact-panel-search-interface-244973-244987/extension_background
npm run lint
LINT_EXIT_CODE=$?
if [ $LINT_EXIT_CODE -ne 0 ]; then
  exit 1
fi

