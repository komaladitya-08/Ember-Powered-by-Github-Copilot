#!/bin/bash
# Fails if any x86-64 ELF under <dir> needs a newer glibc / libstdc++ than RHEL 8.4 ships
# (GLIBC_2.28, GLIBCXX_3.4.25, CXXABI_1.3.11). Prints one line per binary.
# usage: scripts/check-symvers.sh <dir> [<dir> ...]
set -u
MAX_GLIBC=2.28
MAX_GLIBCXX=3.4.25
MAX_CXXABI=1.3.11

newer() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" != "$2" ]; }

fail=0
for dir in "$@"; do
  while read -r f; do
    file -b "$f" | grep -q 'ELF 64-bit.*x86-64' || continue
    file -b "$f" | grep -q 'musl' && continue
    syms=$(objdump -T "$f" 2>/dev/null)
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
  done < <(find "$dir" -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' -o -perm -u+x \) 2>/dev/null)
done
exit $fail
