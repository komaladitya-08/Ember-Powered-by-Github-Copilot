# Detached-root child-policy comparison

This is a code-only, separate fixed experiment from `77ac2734d4d54faef2b3bdcc72198ceacb90f19a`.
No native run or product change is established here. The original policy witness, its C program, builder, build pin,
compiled issuer and intended descendant flags remain unchanged.

The fourth original matrix, run `43878444846`, observed ordinary-host case 1 return `3221225794` (`0xc0000142`) on
both Server images after root exit and private-job zero. The existing terminal owner fence prevented reading the C
report. Baseline case 0 and broker-created leaf case 8 passed. Those observations do not locate execution before
`main`, prove that no checkpoint was written, or identify a DLL.

Microsoft [MS-ERREF](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55)
names `0xc0000142` `STATUS_DLL_INIT_FAILED`. [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
returns before initialization completes and documents termination if a required DLL cannot load or initialize.
Microsoft's pinned [console allocation specification](https://github.com/microsoft/terminal/blob/f6de9e0618015def1c9dda5b82f9d3abf03eb799/doc/specs/%237335%20-%20Console%20Allocation%20Policy.md#L103)
states that `CREATE_NO_WINDOW` still spawns a console host, while `DETACHED_PROCESS` spawns none. This motivates a
console-startup hypothesis; it does not prove that child policy denied a particular operation in the original run.
The earlier six LPAC comparisons changed the intended descendant's console flags while leaving the root unchanged.

## One fixed change

Both trusted ordinary roots and zero-capability LPAC roots use `0x0008040c` in place of `0x08080404`: replace
`CREATE_NO_WINDOW` with `DETACHED_PROCESS`, keeping suspension, Unicode environment and extended startup information.
A test-only wrapper intercepts only the exact original `CreateProcessW` FFI prototype and ten-argument call. It
requires the original flag value before forwarding; no caller selects flags. Every other argument is forwarded with
the same identity. Malformed or combined flag calls fail before invoking the native function.

The original factory still constructs and checks both IO handles, the exact handle-list attribute, zero capabilities,
package SID, AAP opt-out, optional child-policy birth attribute and synchronous inheritance-reset window. The C
descendant calls keep their original console flags. No canonical launcher/API, policy setter, ACL, capability,
registry setting, CRT entry point or runtime flag is changed.

The new **run** issuer is `ember-experimental-windows-child-policy-detached-root-fixed-probe`. It explicitly records
the original **compiled** issuer, `ember-experimental-windows-child-process-policy-fixed-probe`, and both root flag
values. The unchanged builder authenticates its original source recipe, tools, PE and compile commit. It retains
`/GS /MT /SUBSYSTEM:CONSOLE`, normal CRT startup and the original link inputs. This comparison does not claim a new
compiled artifact issuer or OpenJS provenance.

## Unchanged observation and lifetime gates

The dedicated workflow runs the same nine fixed cases on Server 2022 and 2025. The original workflow's native matrix
skips only this exact new PR head; its Linux fault tests and intentional manual dispatch remain available. Future PR
heads retain the original workflow behavior. This prevents two automatic nine-case matrices for the same comparison.

The proof is a narrowly reviewed copy that changes the IO import, checks the compiled issuer and adds the fixed run
variant to public results. The original private-job limit of two, true ordinary image/token control, restricted birth
attestation, canary and parent-right checks, two incoming IO handles, exact image/pins, report parsing, natural-exit
readout gates, Stop, owner retention and cleanup fences remain intact. A nonzero root exit still prevents C payload
readout and release authority. No raw native output, path, PID, handle or SID is published.

A successful comparison would establish only these fixed observations in the detached-root context. Even a change
from `0xc0000142` to a complete report would establish a dependency on this controlled variation, not identify the
failed DLL. Unsupported self-setter routes and LPAC direct creation without valid same-route positive controls remain
inconclusive. No generic child-policy, Node/toolchain, broker or product capability is enabled.

## Portable verification

Actual injected FFI tests compare original and detached calls for both roles and all three birth-attribute choices,
including every other argument, capability/AAP data, two-handle list, startup fields and inheritance reset. Pure gate
tests reject malformed flags before native invocation and pin the three original compile-input hashes. Main-proof
tests invoke the detached proof through synthetic native/file boundaries for all nine fixed argument selections and
verify terminal-owner retention. These are portable contract checks, not Windows ABI or native outcomes.

No fifth native dispatch, push or implementation conclusion follows from this document. The exact diff, focused
checks and coordinated typecheck require review before any native run.
