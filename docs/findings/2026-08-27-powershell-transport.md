# How to actually hand a script to PowerShell — measured

**Date:** 2026-08-27 · **Ticket:** `T-09` · **Measured on:** PowerShell 7.5.0
(`mcr.microsoft.com/powershell:mariner-2.0-arm64`), linux-arm64

Four claims in `packages/sensors/src/support/windows/` rest on how PowerShell behaves rather than
on how it is documented. All four are recorded here because each of them, wrong, produces a
sensor that reports a plausible number or nothing at all rather than a failure — and none of them
is visible from a unit test.

## 1. `-Command -` runs nothing, and says nothing about it

The transport originally passed the script on **stdin** via `-Command -`, on the reasoning that a
command line is world-readable and stdin is not. Pointed at a real `pwsh`, the multi-line
`try`/`catch` wrapper this transport is built around produced:

```
$ pwsh -NoProfile -NonInteractive -NoLogo -Command - < wrapper.ps1
(no output)
$ echo $?
0
```

Exit code 0, empty stdout. `-Command -` reads stdin as *interactive input*, so a multi-line
construct never completes. The transport would have reported "PowerShell printed no result line"
on every check for ever, and the tests could not have caught it: a fake interpreter reads stdin
because it was written to.

`-File -` is worse — it opens a REPL and echoes continuation prompts:

```
$ pwsh -NoProfile -NonInteractive -NoLogo -File - < wrapper.ps1
PS /> try {
>>   $x = 1 + 1
```

**`-EncodedCommand` (base64 of UTF-16LE) is the form that works**, identically on 5.1 and 7:

```
$ pwsh -NoProfile -NonInteractive -NoLogo -EncodedCommand <base64>
A2
```

Putting the script in argv is fine, and the original reasoning against it was misapplied: **the
script is not the secret**. It contains `$env:MS_WIN_PASSWORD`, not a password. The credential
still travels in the environment, which a process listing cannot reach. What a command line
exposes is which CIM class a sensor asks about.

## 2. `-Depth` is not a limit, it is a silent replacement

`ConvertTo-Json` defaults to a depth of 2 and does not fail when it runs out — it substitutes the
**type name** and carries on:

```
default: {"deep":{"a":{"b":"System.Collections.Hashtable"}}}
depth6:  {"deep":{"a":{"b":{"c":{"d":{"e":5}}}}}}
```

`"System.Collections.Hashtable"` is a string, the document parses, and a path that reached a
number yesterday reaches a type name today. (It does write a warning — to the *warning* stream,
which the wrapper silences because a warning in stdout lands in the middle of the JSON.)

## 3. One row is an object and two are an array

The sharpest edge in the transport, confirmed:

```
one:     {"n":1}
two:     [{"n":1},{"n":2}]
```

`@(...)` does not help. `-AsArray` fixes it and exists only in PowerShell 7, while 5.1 is what is
installed on a Windows Server. So a volume sensor written against a machine with two disks works,
and the same sensor on a machine with one disk reads a bare object where it expected a list.
`asRows` is the one place that meets it.

## 4. The wrapper's `try` covers the session, and the envelope survives a failure

Run against a Linux `pwsh`, where `CimCmdlets` does not exist, the remote wrapper produced:

```json
{"ok":false,
 "error":"The term 'New-CimSessionOption' is not recognized as a name of a cmdlet…",
 "category":"ObjectNotFound",
 "type":"System.Management.Automation.CommandNotFoundException"}
```

— which confirms three things at once: the session setup is inside the `try`, the `finally` does
not fault on a `$MsSession` that was never assigned, and a failure comes back as a parseable
envelope rather than as a crash the transport has to guess at. A deliberate `throw` produced the
same shape with `category: OperationStopped`.

UTF-8 output was confirmed in the same run: `café` arrived as the bytes `c3 a9`, not as the
console code page.

## What is still unverified

`Get-CimInstance` against a real Windows machine. Everything above runs on Linux; the *queries*
in `T-10`'s four sensors do not, and are written against recorded output. The first run against
Windows is an open item on `T-10` rather than an implied pass.
