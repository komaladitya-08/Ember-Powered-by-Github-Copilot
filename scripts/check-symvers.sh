#!/bin/bash
# Fails if any x86-64 or aarch64 ELF under <dir> needs a newer glibc / libstdc++ than RHEL 8.4 ships
# (GLIBC_2.28, GLIBCXX_3.4.25, CXXABI_1.3.11). Prints one line per binary. aarch64 binaries are the remote
# agent's koffi.node for Linux arm64 remotes (dist/remote-parts), read with readelf, which reads any ELF.
# It fails closed: a binary it can't read fails, and so does finding no binaries at all.
# Exit: 0 all compatible, 1 something isn't (or nothing was checked), 2 it can't check.
# usage: scripts/check-symvers.sh <dir> [<dir> ...]
set -u
MAX_GLIBC=2.28
MAX_GLIBCXX=3.4.25
MAX_CXXABI=1.3.11

[ $# -gt 0 ] || { echo "usage: $0 <dir> [<dir> ...]" >&2; exit 2; }
for tool in file objdump readelf find; do
  command -v "$tool" > /dev/null || { echo "check-symvers: '$tool' is missing (dnf install file binutils findutils)" >&2; exit 2; }
done
for dir in "$@"; do
  [ -d "$dir" ] || { echo "check-symvers: no such directory: $dir" >&2; exit 2; }
done

newer() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" != "$2" ]; }

list=$(mktemp)
trap 'rm -f "$list"' EXIT
fail=0
checked=0
for dir in "$@"; do
  find "$dir" -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -perm -u+x \) -print0 > "$list" \
    || { echo "check-symvers: couldn't list everything under $dir" >&2; exit 2; }
  while IFS= read -r -d '' f; do
    kind=$(file -b "$f") || { echo "FAIL ${f}: file couldn't read it"; fail=1; continue; }
    aarch64=0
    if ! echo "$kind" | grep -q 'ELF 64-bit.*x86-64'; then
      echo "$kind" | grep -q 'ELF 64-bit.*aarch64' || continue
      aarch64=1
    fi
    echo "$kind" | grep -q 'musl' && continue
    checked=$((checked + 1))
    if echo "$kind" | grep -q 'statically linked'; then
      echo "ok   ${f} (statically linked)"
      continue
    fi
    # An x86-64 host's objdump can't read aarch64 code; readelf's version needs name the same GLIBC_* versions.
    if [ "$aarch64" -eq 1 ]; then
      if ! syms=$(readelf -V --wide "$f" 2>&1); then
        echo "FAIL ${f}: readelf couldn't read its version needs: $(echo "$syms" | tail -1)"
        fail=1
        continue
      fi
    elif ! syms=$(objdump -T "$f" 2>&1); then
      echo "FAIL ${f}: objdump couldn't read its symbols: $(echo "$syms" | tail -1)"
      fail=1
      continue
    fi
    g=$(echo "$syms" | grep -oE 'GLIBC_[0-9.]+' | sed 's/GLIBC_//' | sort -uV | tail -1)
    x=$(echo "$syms" | grep -oE 'GLIBCXX_[0-9.]+' | sed 's/GLIBCXX_//' | sort -uV | tail -1)
    c=$(echo "$syms" | grep -oE 'CXXABI_[0-9.]+' | sed 's/CXXABI_//' | sort -uV | tail -1)
    bad=""
    [ -n "$g" ] && newer "$g" "$MAX_GLIBC" && bad="$bad GLIBC_$g"
    [ -n "$x" ] && newer "$x" "$MAX_GLIBCXX" && bad="$bad GLIBCXX_$x"
    [ -n "$c" ] && newer "$c" "$MAX_CXXABI" && bad="$bad CXXABI_$c"
    if [ -n "$bad" ]; then
      echo "FAIL ${f}:${bad}"
      fail=1
    else
      echo "ok   ${f} (GLIBC_${g:-none} GLIBCXX_${x:-none} CXXABI_${c:-none})"
    fi
  done < "$list"
done
if [ "$checked" -eq 0 ]; then
  echo "FAIL no x86-64 or aarch64 glibc binaries found under: $*"
  exit 1
fi
exit $fail
