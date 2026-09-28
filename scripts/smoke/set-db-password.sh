#!/usr/bin/env bash
# Gives the database role, and /etc/ms/core.json, the password in MS_SMOKE_PASSWORD (`H-21`).
#
# `smoke-restore.sh` uses one with shell in it — a `$`, a quote, a backtick, `$(…)` — because
# `ms-backup` and `ms-restore` used to `eval` the configuration, and a password like that either
# aborted them or ran as root. Node does the writing so that the password never passes through a
# shell here either: this proves the scripts, not the test's quoting.
set -euo pipefail

node - <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const password = process.env.MS_SMOKE_PASSWORD;
if (!password) throw new Error("MS_SMOKE_PASSWORD is not set");
writeFileSync(
  "/tmp/set-password.sql",
  `ALTER ROLE monitoring PASSWORD '${password.replaceAll("'", "''")}';\n`,
  { mode: 0o644 },
);
const path = "/etc/ms/core.json";
const cfg = JSON.parse(readFileSync(path, "utf8"));
cfg.database.password = password;
writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
NODE
su postgres -c 'psql -q -d monitoring -f /tmp/set-password.sql'
rm -f /tmp/set-password.sql
echo "database password set"
