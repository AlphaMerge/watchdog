#!/usr/bin/env bash
# What a Mac's tar leaves in a release (`H-20`).
#
# Source this; it defines functions and sets nothing else.
#
# Repacking a release on a Mac writes an AppleDouble `._<name>` beside every file that has extended
# attributes, and zip tools add a `__MACOSX` directory for the same thing. macOS `tar -t` folds the
# AppleDouble entries back in and never lists them; GNU tar unpacks them as files. A release
# repacked that way for `H-20`'s own smoke test carried 17,847 of them, node-gyp-build loaded
# `._argon2.armv8.glibc.node` ahead of the real one, and the core died at start with "invalid ELF
# header", before the check that run was for.

# `ms_mac_metadata_count` reads a tar listing on stdin, one path per line as GNU tar prints it, and
# prints how many entries are an AppleDouble file or are in a `__MACOSX` directory. Returns
# non-zero when the listing cannot be read. List with GNU tar: the macOS one hides these entries.
#
# `grep -c` prints the count either way and exits 1 when it is 0, which is not a failure here.
ms_mac_metadata_count() {
  grep -c -E '(^|/)(\._[^/]*|__MACOSX)(/|$)' || [ "$?" -eq 1 ]
}
