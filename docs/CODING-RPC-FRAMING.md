# Bounded RPC transport experiment

The Linux isolation experiment has an explicit `proxyForTest` launch option. A test bundles
`app/main/agent/coding-rpc-proxy.ts` into a fresh private CJS file, supplies that file and a trusted host Node executable,
and launches the pinned SDK through this helper. This is not a packaged production launcher and does not open the
coding gate.

The process path is:

```text
Host SDK and model broker ↔ bounded host Node proxy ↔ Bubblewrap ↔ isolated Copilot runtime
```

The proxy runs outside the sandbox as trusted host code. Its immutable, non-secret launch specification contains
only the host-built Bubblewrap arguments, the private seccomp/namespace-receipt file paths and framing limits. It
executes `/usr/bin/bwrap` without a shell, permits only the pinned SDK's expected appended flags, and gives the child
fixed non-secret environment values. Only seccomp/info descriptors 3 and 4 are explicitly inherited for Bubblewrap to
consume. They do not reach native tool processes in the tested flow.

Each direction has a `Content-Length` guard before the receiving JSON-RPC implementation. The guard validates the
complete header and advertised body size before forwarding a header. It never allocates the advertised body size.
It bounds header/chunk/frame sizes, cumulative wire bytes, frame counts, stream buffering, per-frame time and helper
lifetime, and uses pipelines that honour backpressure. An invalid/truncated/oversized stream, failed pipe or elapsed
deadline tears down the helper's child namespace and closes the SDK pipe. Child stderr is discarded rather than
forwarded into SDK buffers.

The defaults allow an 8 KiB header, 16 MiB body, 20,000 frames and 128 MiB admitted wire bytes per direction. They use
256 KiB maximum input chunks, 16 KiB stream high-water marks, a 30-second frame deadline and a 20-minute helper
lifetime. Only bounded configured values are accepted. These are experimental resource limits, not a statement that
every legitimate coding task fits them.

The model request handler remains host-side. In the tested configuration, the namespace has no network access and
receives only a public synthetic provider placeholder. Its fixed session/model requests travel over guarded stdio
to the host's broker; the broker alone supplies the synthetic upstream credential. The proxy spec and sandbox
environment contain no credential. A frame guard validates framing and resource use, not RPC authority: the broker
and session handler still validate the exact route, method, session, budgets and cancellation.

## Evidence and limits

`test/integration/coding-rpc-proxy-isolated.test.ts` exercises the actual SDK, test-bundled helper, Bubblewrap,
no-network runtime, host broker, a native file edit and the stopped review/export lifecycle. A separate hostile-runtime
fixture inside the real namespace emits an oversized `Content-Length` with no body; startup fails promptly, the
namespace exits, the SDK receives no completed oversized frame, and no model request or delayed write occurs.
The unaccepted startup receipt leaves its disposable files in place until the test independently observes exit.
The framing unit tests establish that the offending header is withheld rather than forwarded.

The native-child attempt to open another process's `/proc` stdout did not reach the RPC pipe in this environment;
it is not the evidence used for the malformed-frame test.

Wire bounds do not bound JSON object expansion, JSON nesting, SDK pending handlers, every OS pipe allocation or a
caller that ignores writable backpressure. The model broker has its own request/response budgets. The experiment
still depends on trusted host assets, its incomplete syscall policy, and Linux-specific namespace/capture evidence.
Other hostile host-user processes and privileged mutation are outside its guarantees. Supported providers,
production packaging/lifecycle, crash recovery and Windows/macOS equivalents need separate verification.

See [CODING-RESULT-EXPORT.md](CODING-RESULT-EXPORT.md) for the namespace shutdown receipt, conflict-preserving export
and why this does not authorize automatic copy-back to the original project.
