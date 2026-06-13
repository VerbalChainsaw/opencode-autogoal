#!/usr/bin/env bash
# guard-spec-ref.sh — pre-commit hook.
#
# Enforces the rule in AGENTS.md §4: every commit that touches
# src/**/*.ts or src/**/*.tsx must cite a specs/ file in the
# commit message. The hook reads the COMMIT_EDITMSG file git
# populates, and runs the staged diff through git diff --cached
# --name-only to see what changed.
#
# Exit codes:
#   0 — commit is allowed
#   1 — commit is blocked (no spec ref); a stderr message
#       tells the author how to fix it
#
# Special tags the hook explicitly allows (so trivial commits
# don't get blocked):
#   [no-spec]   — the commit doesn't touch src/; or it does,
#                 but the author asserts no spec applies
#                 (e.g., a typo fix). The agent should split
#                 such commits per AGENTS.md §4.
#
# The hook is portable bash for git-bash on Windows + any
# POSIX shell on Linux/macOS.

set -eu

# Resolve the git directory even from subdirectories.
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null) || {
  echo "guard-spec-ref: not inside a git repository" >&2
  exit 1
}

# COMMIT_EDITMSG is the file git has the author writing the
# message into. We read it; if it doesn't exist (e.g., the
# commit is being made via -m with a single-line message,
# git still writes it to COMMIT_EDITMSG before invoking
# hooks, so this should always be present).
MSG_FILE="$GIT_DIR/COMMIT_EDITMSG"
if [ ! -f "$MSG_FILE" ]; then
  # No message file — let the commit through; git will error
  # on its own if the message is invalid.
  exit 0
fi

# Read the message. Strip the "#" comment lines git adds.
MSG=$(grep -v '^#' "$MSG_FILE" || true)

# Allow [no-spec] tag explicitly.
if echo "$MSG" | grep -q '\[no-spec\]'; then
  exit 0
fi

# Get the list of files staged for this commit.
STAGED=$(git diff --cached --name-only)

# Only enforce when src/**/*.ts or src/**/*.tsx is staged.
TOUCHES_SRC=0
for f in $STAGED; do
  case "$f" in
    src/*.ts|src/*.tsx|src/**/*.ts|src/**/*.tsx)
      TOUCHES_SRC=1
      break
      ;;
  esac
done

# No src/ changes — no spec required.
if [ "$TOUCHES_SRC" -eq 0 ]; then
  exit 0
fi

# src/ changed — the commit message must cite a spec file.
# The regex matches:
#   specs/<path>.md
#   specs/<path>.md §N      (optional section reference)
#   specs/<path>.md §N.M
#
# Examples of accepted references:
#   (spec §2.2)
#   specs/render-protocol-design.md
#   specs/render-protocol-design.md §3.1
#   spec §4.1
#   see spec §2.2
SPEC_RE='(specs/[a-zA-Z0-9_./-]+\.md( *§[0-9.]+)?|spec *§[0-9.]+)'

if echo "$MSG" | grep -qiE "$SPEC_RE"; then
  exit 0
fi

# Block.
cat >&2 <<'EOF'

guard-spec-ref: COMMIT BLOCKED.

The staged diff touches src/ but the commit message does not
cite a spec. Per AGENTS.md §4, every src/ change must reference
specs/<file>.md (optionally with a §N.M section).

Fix one of:
  1. Add a spec reference to your commit message, e.g.:
       feat(blocks): emit stat-row for eval failures (spec §2.2)
  2. If this is a trivial change that genuinely doesn't need
     a spec (e.g., a typo fix), tag it [no-spec] AND split it
     into its own commit per AGENTS.md §4.
  3. Re-read the spec surface (ls specs/) and cite the
     relevant file. The spec wins. AGENTS.md §1.

To inspect the staged changes:
  git diff --cached --stat
  git diff --cached --name-only

To inspect the current spec surface:
  ls specs/
  head -50 specs/*.md

EOF
exit 1
