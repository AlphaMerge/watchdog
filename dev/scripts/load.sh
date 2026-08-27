#!/bin/sh
# The advanced format: several channels from one run, in this system's own shape.
set -eu
read -r one five fifteen _rest < /proc/loadavg
printf '{"channels":[{"key":"load1","name":"Load (1 min)","value":%s},{"key":"load5","name":"Load (5 min)","value":%s},{"key":"load15","name":"Load (15 min)","value":%s}],"message":"load average %s %s %s"}\n' \
  "$one" "$five" "$fifteen" "$one" "$five" "$fifteen"
