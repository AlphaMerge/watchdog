#!/usr/bin/env python3
"""Generate the WiX directory tree and component references for the MSI (TASKS.md H-06).

    wxs-tree.py <payload-dir> <tree.wxs> <refs.wxs>

A release is thirteen thousand files under `app/node_modules`, so the component list is generated
rather than written: a hand-maintained one would be wrong the first time a dependency changed,
and the failure that produces is an installer quietly missing a file.

**The ids and GUIDs are derived from the path, deterministically.** Two builds of one release have
to produce the same component GUIDs or every upgrade looks to the installer like a different
product. Python's `hash()` is salted per process and cannot be used for this; `uuid5` over a fixed
namespace can.

Components are nested inside their `<Directory>` rather than attached with `<DirectoryRef>`,
because wixl compiles one document at a time and a bare sequence of `DirectoryRef` elements is not
one.
"""

import os
import sys
import uuid
from xml.sax.saxutils import quoteattr

NAMESPACE = uuid.UUID("7b2b5d2c-9f4e-4d31-88f3-1a5c6e9d0b47")


def ident(prefix: str, path: str) -> str:
    """A stable, legal WiX identifier for a path, readable enough to debug."""
    digest = uuid.uuid5(NAMESPACE, path).hex[:12]
    safe = "".join(ch if ch.isalnum() else "_" for ch in path)[-48:].strip("_")
    return f"{prefix}_{digest}_{safe}" if safe else f"{prefix}_{digest}"


def emit(payload: str, rel: str, indent: str, out, components: list[str]) -> None:
    """One directory: its files as components, then its subdirectories."""
    absolute = os.path.join(payload, rel) if rel else payload
    entries = sorted(os.listdir(absolute))

    for name in entries:
        full = os.path.join(absolute, name)
        if not os.path.isfile(full) or os.path.islink(full):
            continue
        rel_file = os.path.join(rel, name) if rel else name
        comp_id = ident("cmp", rel_file)
        components.append(comp_id)
        guid = str(uuid.uuid5(NAMESPACE, rel_file)).upper()
        out.write(f'{indent}<Component Id="{comp_id}" Guid="{guid}">\n')
        # **Relative to the payload root, not absolute.** wixl resolves `Source` against its
        # working directory and rejects an absolute path outright, with a GLib assertion rather
        # than a message that says so.
        out.write(
            f'{indent}  <File Id="{ident("fil", rel_file)}" Name={quoteattr(name)} '
            f'Source={quoteattr(rel_file)} KeyPath="yes" />\n'
        )
        out.write(f"{indent}</Component>\n")

    for name in entries:
        full = os.path.join(absolute, name)
        if not os.path.isdir(full) or os.path.islink(full):
            continue
        rel_dir = os.path.join(rel, name) if rel else name
        out.write(f'{indent}<Directory Id="{ident("dir", rel_dir)}" Name={quoteattr(name)}>\n')
        emit(payload, rel_dir, indent + "  ", out, components)
        out.write(f"{indent}</Directory>\n")


def main() -> int:
    payload, tree_out, refs_out = sys.argv[1], sys.argv[2], sys.argv[3]
    components: list[str] = []

    with open(tree_out, "w", encoding="utf-8") as out:
        emit(payload, "", "          ", out, components)

    with open(refs_out, "w", encoding="utf-8") as out:
        for comp_id in components:
            out.write(f'      <ComponentRef Id="{comp_id}" />\n')

    directories = sum(len(dirs) for _, dirs, _ in os.walk(payload))
    print(f"    {len(components)} files in {directories + 1} directories")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
