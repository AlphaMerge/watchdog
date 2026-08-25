#!/usr/bin/env bash
# Points the installed core at the local database. The shipped example config has an empty
# password, which is correct for a template and wrong for a running service.
set -euo pipefail

node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const path = "/etc/ms/core.json";
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  cfg.database.password = "monitoring";
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
'
echo "core configured"
