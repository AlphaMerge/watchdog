#!/bin/sh
# PRTG's advanced *XML*, which is what its EXE/Script Advanced sensors emit by default (T-24).
# The JSON sibling of this script is prtg-style.sh; an installation moving across has both.
set -eu
printf '<?xml version="1.0" encoding="UTF-8"?>\n<prtg>\n  <result><channel>Free Space</channel><value>%s</value><unit>%%</unit></result>\n  <result><channel>Inodes</channel><value>%s</value></result>\n  <text>from a PRTG-style XML script</text>\n</prtg>\n' \
  "$(( 60 + $(date +%S) % 40 ))" "$(( 100000 + $(date +%S) ))"
