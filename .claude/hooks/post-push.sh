#!/usr/bin/env bash
# PostToolUse hook: fires after every `git push` command.
# Reminds Claude to update the PR description and subscribe to activity.

branch=$(git branch --show-current 2>/dev/null)
if [ -z "$branch" ]; then
  exit 0
fi

cat <<EOF
POST-PUSH CHECKLIST — You just pushed to "$branch". Do these now:
1. Update the PR description to reflect the current state (what changed, open questions).
2. Subscribe to PR activity (subscribe_pr_activity) if not already subscribed.
EOF
