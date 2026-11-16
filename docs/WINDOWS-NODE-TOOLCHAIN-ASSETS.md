# Pinned Windows Node assets

This packaging foundation supplies no model tool, execution selector, native grant or Stop authority. Windows coding
remains files-only until a separate production asset owner, command workspace and full native/product journey pass.

The manifest pins the existing offline CNG Node 22.23.5 producer from run `43858256344`, artifact `14224884648` and
compile commit `df3d273dc1028f2358a119db0719b4cf2cb471f9`. Its 120,219,136-byte executable, complete Node licence,
producer receipt and unshipped bootstrap all have exact size/SHA-256 pins. This preserves the original producer's
experimental provenance; the packaging check is not a new native enforcement certificate.

After independently authenticating and extracting those four producer members into `.cache/windows-node-toolchain`,
stage Windows x64 with `node scripts/package/stage.mjs --with-windows-node-toolchain` (plus the usual model/runtime
flags). Three files go under `resources/coding/windows-node-x64`: `node.exe`, `LICENSE` and `build-receipt.json`.
The licence is named in the package notices. Other platforms refuse the flag. Existing packages are checked before
replacement, and staging rechecks exact bytes before and after copying. No token, runtime download or installed-Node
fallback is used. The standalone stager accepts an independently verified producer directory and a new destination.

Reads are bounded to the pinned size through held descriptors, verify EOF, identity, link count and hashes, and reject
extra files, Node-classified symbolic links/junctions and hardlink aliases. These checks do not identify every Windows
reparse tag; native admission must independently enforce its complete reparse/stream policy. Staging creates only a
new leaf, rechecks its captured identity around writes and final verification, writes with exclusive creation,
flushes and verifies the final files. It never recursively deletes a supplied destination. Unknown descriptor closure
retains its owner behind a private process-lifetime barrier. Package integrity checks mint no execution receipt;
the future native owner must independently hold and authenticate the assets, exact process image and profile grants.

The declared profile is offline, root-only Node with no shell, child processes, network or dependency installation.
The preserve-symlink module-resolution flags and single-process test-isolation flag are explicit compatibility facts.
This stager adds no implicit arguments; the eventual guarded invocation must display and preserve its literal argv.
Asset retention in GitHub Actions is not a permanent distribution service. Moving the exact files to a durable
release channel remains a separate publishing action after acceptance; there is no automatic substitution on expiry.

Validation passed 113 portable packaging/licence cases across three suites, six real pinned-artifact staging/tamper
cases at the existing default deadlines, full TypeScript (`36195`, exit 0), lint, syntax, diff and workflow checks.
Independent review closed after the destination-identity regression, reparse-claim correction and Unicode-3.0
licence inventory update. The exact workflow archive-extraction code is also exercised locally. An earlier combined
real-artifact case exceeded its five-second bound after adding the directory-replacement regression; it was split
into six separate checks, preserving the default deadline and every assertion. No product or Stop budget changed.

The dedicated `Windows Node toolchain assets` workflow reads only the fixed producer artifact, authenticates the
archive and all four members, and requires the real staging/tamper suite. It downloads no model credentials and
executes no Node PE. Full packaged Ember staging with the new flag remains to be exercised on Windows after the
production workspace is integrated; these checks do not establish Windows command usability.
