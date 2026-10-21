#!/bin/sh
# Stands in for `claude -p "/usage"` in tests. Counts runs when FAKE_CLAUDE_USAGE_LOG is set,
# so a test can tell cached answers from fresh probes.
# `claude auth status` answers as the real one does, with the plan it reports.
if [ "$1" = "auth" ]; then
  printf '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"%s"}\n' "${FAKE_CLAUDE_PLAN:-max}"
  exit 0
fi
[ -n "$FAKE_CLAUDE_USAGE_LOG" ] && date -u +%FT%TZ >> "$FAKE_CLAUDE_USAGE_LOG"
cat <<'EOF'
You are currently using your subscription to power your Claude Code usage

Current session: 95% used · resets Oct 10, 12:40pm (UTC)
Current week (all models): 40% used · resets Oct 11, 7am (UTC)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine.
EOF
