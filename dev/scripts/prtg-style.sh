#!/bin/sh
# PRTG's own advanced JSON, unchanged — an installation's existing scripts work as they are.
set -eu
printf '{"prtg":{"result":[{"channel":"Free Space","value":"%s","unit":"%%"},{"channel":"Inodes","value":%s}],"text":"from a PRTG-style script"}}\n' \
  "$(( 60 + $(date +%S) % 40 ))" "$(( 100000 + $(date +%S) ))"
