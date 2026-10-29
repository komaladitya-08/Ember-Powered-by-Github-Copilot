# Package voice: speech-model download and extraction without system tar/bzip2/curl

Worktree: /home/user/wt/voice (branch port/voice).
Specs to read: system.md (voice and models sections), decisions.md D7.

## Problem
app/voice/models.ts extracts the pinned speech-model archives (.tar.bz2) by shelling out to `tar -xjf`, and a downloader
path uses `curl`; scripts/voice/prepare.mjs does the same (`curl`, `tar -xjf`). On Windows, `tar` may be Git's GNU tar
(no bzip2) or an old bsdtar; macOS has bsdtar but we should not depend on system tools at all for something the app does
at run time. Make extraction (and, if the app path uses curl, downloading) work identically on Linux, Windows and macOS.

## You own (and touch nothing else)
- app/voice/models.ts, and new files under app/voice/ for the extractor (e.g. app/voice/untar.ts, app/voice/bzip2.ts)
- scripts/voice/prepare.mjs
- test/unit/voice-models.test.ts and new test/unit/voice-untar.test.ts / voice-bzip2.test.ts
- ONLY if you choose a dependency instead of your own decoder: package.json "dependencies" (exact pin), package-lock.json
  (via `npm install <pkg>@<exact> --save-exact` run in YOUR worktree — note node_modules is a symlink to the main checkout:
  instead, copy package.json/package-lock.json changes by hand or run npm with a real node_modules copy in a temp dir; never
  modify the main checkout's node_modules), and the `License:` line + its comment in packaging/rpm/ember.spec if the
  dependency's licence isn't already listed. Prefer NOT adding a dependency.

## Requirements
1. A streaming, in-process .tar.bz2 extractor in TypeScript: a bzip2 decompressor (Huffman/MTF/BWT, multiple streams/blocks,
   CRC checks — fail closed on a bad CRC) and a ustar/GNU tar reader (regular files, directories, long names via GNU 'L'
   and pax 'x' headers, skip others). Safety: reject absolute paths, `..` components, symlinks/hardlinks, and anything that
   would land outside the destination; cap total size (the models are ~126 MB: allow e.g. 1 GB) and entry count.
   Memory: stream, don't hold the whole decompressed archive. Speed: the 3 archives must extract in a reasonable time
   (measure: report seconds for each real archive on this machine; target under ~10 s total).
2. models.ts uses it instead of `tar`; keep every existing behaviour (SHA-256 check before use, temp file + atomic move,
   pinned URLs, licences, progress callbacks, error messages). If models.ts's default downloader shells out to curl,
   replace it with Node's fetch/https (respecting the proxy only as today's code does; the app injects Electron's net.fetch
   — check voice.ts and keep that path working).
3. prepare.mjs uses the same extractor (import the TS through the existing build approach, or a small shared .mjs; your
   choice, but no duplication of the decoder) and no system curl/tar.
4. Tests: unit-test the bzip2 decoder and tar reader on Linux with small fixtures generated in the test (Linux has `bzip2`
   and `tar` to produce fixtures at test time — but the tests must also pass on Windows/macOS: commit tiny binary fixtures
   under test/fixtures/voice-archive/ (you own that folder) or build archives in pure JS in the test); include
   multi-block input, a corrupted CRC (must throw), path traversal entries (must be refused), long names. Then verify
   against the REAL model archives: run `node scripts/voice/prepare.mjs` (downloads ~126 MB from GitHub releases into
   .cache/voice in your worktree; if the network blocks it, say so) and check the extracted file list and every SHA-256
   that models.ts pins for the extracted files (if it pins only archives, compare the extracted tree with `tar -tjf`).
   Also run the existing voice unit tests and, if the models are present, `EMBER_VOICE_TEST=1 npx vitest run
   test/integration/voice.test.ts` with EMBER_INTEGRATION=1.
