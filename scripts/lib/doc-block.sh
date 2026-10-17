#!/usr/bin/env bash
# A block of a document, as the document shows it (`H-25`).
#
# Source this; it defines functions and sets nothing else.
#
# **What a runbook tells an operator to paste is what the tests run.** `smoke-install.sh` installs
# the `OnFailure=` drop-in and runs the outside checks from `docs/administration.md`, and
# `deploy-scripts.test.ts` runs the checks too, both by taking the blocks out of the document
# rather than keeping copies beside the tests: a copy goes on passing after the runbook has
# changed, and then it is a test of something nobody runs.

# `ms_doc_block FILE LINE` prints the one fenced block of FILE (between two lines of three
# backticks) that has LINE among its lines, compared with each line's leading blanks removed. It
# prints the block's lines without the fences and without the indentation of its opening fence,
# which a block inside a list item has. Prints nothing and exits 1 when no block has that line,
# and 2 when more than one does, so a document that grows a second copy cannot pass on the first.
# POSIX awk: it runs on the macOS host as well as in the toolchain.
ms_doc_block() {
  awk -v want="$2" '
    function bare(s) { sub(/^[ \t]+/, "", s); return s }
    !inside && /^[ \t]*```/ {
      inside = 1; indent = match($0, /[^ \t]/) - 1; block = ""; has = 0
      next
    }
    inside && /^[ \t]*```[ \t]*$/ {
      inside = 0
      if (has) { found += 1; out = block }
      next
    }
    inside {
      if (bare($0) == want) has = 1
      block = block substr($0, indent + 1) "\n"
    }
    END {
      if (found != 1) exit (found == 0 ? 1 : 2)
      printf "%s", out
    }
  ' "$1"
}
