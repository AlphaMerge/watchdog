#!/bin/sh
# Development example for the execute-program notification method (N-10).
#
# Everything about the alarm arrives in the environment, so a template can name this file and
# pass no arguments at all. The message body arrives on stdin. Anything written to stdout or
# stderr is captured into the core's journal, bounded by notifications.program.maxOutputBytes.
#
# Exit 0 means delivered. Any other code means failed, and the core will *not* try again — a
# notification program is a side effect, and running it five more times because it reported a
# problem is how one alarm becomes five tickets.
set -eu

out="${MS_PROGRAM_EXAMPLE_OUT:-/tmp/ms-notifications.log}"

body="$(cat)"

printf '%s %s %s/%s %s -> %s | %s | %s\n' \
  "${MS_DATETIME}" \
  "${MS_SITE}" \
  "${MS_DEVICE}" \
  "${MS_SENSOR}" \
  "${MS_LAST_STATUS:--}" \
  "${MS_STATUS}" \
  "${MS_SUBJECT}" \
  "$(printf '%s' "${body}" | tr '\n' ' ')" >> "${out}"

echo "recorded to ${out}"
