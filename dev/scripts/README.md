# Development script directory

`probe.scriptDir` points here (`dev/probe.json`), so an EXE/Script sensor (`T-19`) in the
development stack can name one of these programs. Nothing else on the machine is reachable: a
sensor names a file _in this directory_ and the probe refuses anything that resolves outside it.

They are examples, not fixtures — the tests build their own directory in a temporary path. These
exist so somebody can point a sensor at something real without writing one first.

The development probe runs as root in the toolchain container, so `dev/probe.json` also sets
`probe.allowScriptsAsRoot`: without it a root probe with a script directory and no
`probe.processUid` refuses to start (`P-276`). Never copy that setting to a real probe.
