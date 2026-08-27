#!/bin/sh
# PRTG's format: returncode:value:message. This is what an existing EXE script already prints.
set -eu
depth=$(( $(date +%s) % 40 ))
echo "0:${depth}:${depth} jobs waiting on ${MS_HOST:-this device}"
