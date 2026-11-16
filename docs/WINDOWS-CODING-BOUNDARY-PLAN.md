# Windows native coding boundary: validation plan

Reviewed 16 November 2026. The draft product now has an explicit Windows files-only backend with folder grants, copied-file editing, review, continuation, export and Forget. Windows commands, tests and dependency installation remain unavailable. This plan covers the additional command boundary; it does not enable one. The open findings in [HYBRID-CODING-STATUS.md](HYBRID-CODING-STATUS.md) and the export-first contract in [CODING-COPYBACK-DESIGN.md](CODING-COPYBACK-DESIGN.md) remain relevant. The legacy native-SDK coding gate stays false.

## Candidate boundary

The proposed command candidate must isolate **project commands and every project-code descendant** in a fresh zero-capability Less-Privileged AppContainer (LPAC) and private job. The dedicated SDK controller stays in the trusted host with native tools, plugins, hooks, skills, extensions and subagents disabled. Its working/configuration directories are private and empty; project code never runs in that process. The earlier entire-SDK experiment remains a separate comparison path.

Ordinary AppContainer is not a silent fallback if LPAC fails. Microsoft documents AppContainer access as the intersection of user and package/capability rights; LPAC additionally opts out of resources granted to All Application Packages. The application's grants, inherited handles, services and brokers determine the actual boundary. [Microsoft: launching AppContainer and LPAC](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)

Low integrity alone is insufficient: the default mandatory policy prevents writing upwards, rather than universally preventing reads of private user files. Jobs group and terminate processes; their security restrictions are not a substitute for per-process access control. [Mandatory Integrity Control](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control), [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

If the selected command toolchain cannot operate within a narrowly granted container, keep it unavailable while evaluating a separately reviewed implementation. Do not solve compatibility by granting the user's profile, Ember data directory, unrestricted host services or credentials to project code.

The verified [file-only backend](EXPERIMENTAL-WINDOWS-PROJECT-RESOURCES.md) grants fresh copies only owner/SYSTEM access; it does not grant command-package access. That grant/revocation and stopped-writer lease must be implemented and verified before combining it with a launcher. The [direct Node diagnostic](WINDOWS-NODE-LPAC-PROOF.md) independently tests a possible command asset; it is not that integration.

## Current evidence and remaining compatibility work

At submitted product head `60ec77d1`, the dedicated Server 2022/2025 workflows passed 708 checks with no failures or
skips: [controller/app/ZIP](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43818240426)
204, [artifacts/continuation](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43818240422)
410 and [native files](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/actions/runs/43818240486) 94.
These establish their respective file-only scopes, including actual SDK execution denial, genuine development
Home/preload/IPC flows and separate extracted-ZIP launch/dependency proof. They do not execute project commands or
certify physical Windows clients or live accounts. Ordinary CI remains red at the existing LPAC child-launch fixture.

The command experiments remain separate:

- The fixed C/libuv [probe #218](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/218) completed
  local I/O, timer, work-queue, thread and loop operations on both Server images. Its independent ordinary-host
  controls retain the parent's observed security context. It is not Node or an arbitrary-code command backend.
- Official signed Node still fails capability-free LPAC startup at `WSAStartup / 10107`. Earlier source
  [probe #225](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/225) also failed LPAC startup.
  The subsequent offline/CNG/LOCAL source image and its unchanged authenticated
  [reuse #237](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/237) completed fixed filesystem,
  async-read and timer work on both the ordinary host and zero-capability LPAC. Four of the six native controls
  passed; default child spawning and process-isolated tests still failed. These results establish that fixed
  workload, not general offline API behaviour, safe network errors, ordinary tests or a command backend.
- The [child probe #224](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/224) independently
  reproduces both explicit-capability and plain inherited creation denial. It now accounts for console helpers as
  contained writers while selecting exactly one intended image, and requires all held process handles and the job to
  stop before readout. The AAP-only creation variant also reproduced the same access denial on both Server images.
  A subsequent observational diagnostic examines the exact supplied process/thread descriptors without changing
  creation inputs; no successful child launch or repair is established.
- The reviewed Node source's default test runner uses process isolation and three stdio pipes. Its pinned libuv pipe
  implementation lacks the documented `LOCAL` namespace and retries access denial. The independent fixed-C
  [namespace probe #226](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/226) passed 251 portable
  and four native cases per Server image: both ordinary-host pairs connected; LPAC refused the original prefix
  with access denied, while the `LOCAL` pair connected and closed. This establishes a namespace prerequisite only.
  Actual Node/libuv transport, child and default-test-runner proofs remain required.
- PowerShell's ETW patch is insufficient: mandatory machine-environment and GPO policy reads are denied under the
  zero-capability contract. There is no reviewed supported policy-preserving startup opt-out. A host-authoritative
  policy transport would require explicit design and proof; denial cannot become absent policy or broader grants.
  See [the recorded compatibility proof](ISOLATED-WINDOWS-COMMAND-PROOF.md).

These are software investigations that can continue through hosted Windows. A laptop is needed later for the
physical client/app/focus/input/audio/display story; it does not repair these compatibility failures.

## First declared Node command subset

A useful first Windows command milestone can support explicit single-process Node scripts and tests while keeping
subprocesses, npm and network installation unavailable. Pinned Node 22.23.5 requires the exact
`--experimental-test-isolation=none` flag for that test mode. It must appear in the requested invocation; never insert
it into an approved `node --test` command or reinterpret an npm script.

The separate [in-process diagnostic #242](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/242)
preserves the original six assertions and source artifact. Its first native matrix passed the ordinary-host test
on both Server images. LPAC exited 1 before producing a test report, with 144 private output bytes and complete
known cleanup. Those bytes were not viewed; a bounded exact discovery-message diagnostic is pending. The
[creator-owner prerequisite #241](https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/pull/241)
reached first Stop/revocation/private readback on Server 2022, then a file-replacement failure; Server 2025 stopped
at prelaunch metadata validation. Neither experiment establishes a usable product command capability.

After native feasibility passes, the finite product bridge still needs these changes:

- Keep `WindowsCodingCopy` as the sole canonical proposal, original baseline and source authority. Capture detached,
  privacy-validated complete command input under its file lease. Import a complete stopped command snapshot through
  a one-use generation-bound receipt, including deletions and empty directories, without replacing the baseline or
  source grant. Materialise and verify a fresh private root, retire the old root, then commit the new generation.
- Use a fresh command tree/profile per invocation and one outer queue for file tools, command preparation,
  execution, import, review and close. Preserve the stable file-broker object. The current intersection of limits is
  4 MiB per file, 10 MiB total, 4,000 entries and depth 32; excess must fail before launch and on import.
- Extend the root-only lifecycle with a bounded host-only launch-directory context and natural exit observation
  from the exact held process before handle closure. Stop completion cannot become exit 0. A private completion
  receipt must bind the generation, exit/cancellation, stopped writer, revocation and output closure.
- Expose an honest direct-Node capability such as `run_node` with an exact argument array and logical cwd. Keep
  existing real shell identities and `run_command` unchanged. Share the existing consent, original-word authority,
  refusals, approval modes, taint checks, audit, command window and redactor; bind approval to the exact invocation.
- Verify failing test, file-tool repair and exact rerun; command-created/renamed/deleted entries; cumulative review
  and continuation; source unchanged; export; Stop, account revocation and selective/global Forget. Both native
  Server images, the real pinned SDK and a genuine sandboxed Electron product journey must pass before capability
  selection changes. Unknown exit, stream, Stop, revocation, privacy or root-replacement state blocks further work.

The broader shell/descendant contracts below remain relevant to that future capability. A declared Node-only
milestone must prove child-creation denial and containment rather than claim support for arbitrary child execution.

## Prototype contracts

### 1. Files and toolchains

- The host creates a private baseline and a **new-file copy** of explicitly selected project contents. Grant the session package access only to its scratch copy and enumerated read/execute toolchain assets. Keep the original project, Ember state, audit, vault, provider secrets and other sessions inaccessible. Do not change ACLs on source files to make a project accessible.
- Reject hardlinks, reparse points, junctions, mount changes and unsupported filesystem objects during initial copying and result export. Record volume/file identity through opened handles. Recheck type, identity, bounds and directory ancestry as part of the traversal; string path normalisation and a final-component no-follow flag do not establish safe parent traversal.
- NTFS hardlinks share the underlying file's security descriptor. Granting access or changing an ACL through an alias changes authority to the same object, so recursively granting a source tree is unsafe. Test pre-existing aliases and races before any grant. [CreateHardLinkW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw), [FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info), [reparse-point operations](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points-and-file-operations)
- Begin with local NTFS only and a small, versioned command toolchain: pinned Node, any explicitly supported shell and a fixture build/test command. Package caches, configuration and temporary files live inside the session. No automatic host PATH, user Git hooks, SSH agents, credential helpers, package installation or extension discovery. Unsupported tools produce an explicit limitation rather than broader grants.

### 2. Credentials and the trusted controller

AppContainer cannot hide a secret from code to which Ember deliberately gives that secret. Keep real GitHub/provider credentials outside command environments, arguments, files and accessible processes. The trusted controller owns model requests and exposes only Ember's scoped file tools and existing policy-controlled command flow. Verify actual native-tool rejection as well as advertised inventory; test account/project/mode revocation, bounded tool calls, output redaction and private-session disposal. Credentials in the trusted controller are not permission to execute project code there.

Project commands do not call a model, so this custom-tool path does not require a sandbox model proxy or a second implementation of GitHub authentication. The experimental entire-SDK path would additionally require the broker below. Its OpenAI-compatible adapter has offline evidence; it does not implement the default GitHub credential protocol.

The proposed broker performs only authenticated model requests for a host-created session. The host binds account, destination, provider/model, budget and lifetime. The sandbox cannot choose arbitrary URLs, headers, tokens, host file paths or process launches. Validate schemas and sizes, handle streaming/cancellation and refuse redirects outside the allowed destination. Return model responses, never provider credentials; redact provider errors and discard authorisation data from logs. Treat all runtime messages and returned model/tool text as untrusted.

Use a deliberately scoped local IPC channel, not a general network proxy or a new unauthenticated localhost service. A named pipe, if selected, needs explicit endpoint rights and a verified per-session peer identity; a random name or PID alone is not authentication. Deny cross-session and remote use, replay and server-instance impersonation. Default pipe ACLs are too broad for this purpose, and generic write includes the right to create a pipe instance. [Named pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)

Such a broker remains privileged relative to its client, so its parsing, authentication and operations are a security boundary. It must not become a route to general file access, shell execution, arbitrary HTTP or desktop actions. Its exact Windows transport and GitHub compatibility with **SDK 1.0.21/runtime 1.0.97** remain unverified. It must not depend on putting a real bearer token back into the untrusted runtime.

### 3. Process launch, Stop and recovery

- Launch with an explicit clean environment, LPAC capabilities and a minimal inherited-handle list. Assign the process to its private job at creation, or keep it suspended until assignment and every prerequisite has succeeded. Fail before running code if setup fails. Windows exposes creation attributes for AppContainer capabilities, inherited handles and job assignment. [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- Keep the job handle private and non-inherited; enable kill-on-last-handle-close and disable both breakaway options. Stop revokes controller/tool admissions and any optional broker access immediately, requests cancellation, then terminates the job within a defined deadline. Confirm contained processes have exited before traversing or deleting results. An SDK stop response, root PID exit or one completion notification is insufficient.
- Exercise attempts to spawn through WMI, COM, services, scheduled tasks, alternate parents and nested jobs. Microsoft specifically notes that WMI-created children are not automatically members of the parent's job. Such routes must be inaccessible or covered by an independently proven boundary. Job notifications are not universally guaranteed, so combine explicit accounting/liveness checks with containment evidence. [Job membership and termination](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- Probe broker/Ember process access, including memory read/write, handle duplication, token operations and parent-process creation rights, with synthetic secrets only. No credential-bearing process or job control handle may be inherited. [Process access rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights)
- On crash or unknown surviving state, block new coding work and retain diagnostics without secrets. Do not delete an unknown directory or infer that all descendants stopped from a stale PID. Establish how a restarted host recognises and terminates its exact session without adopting an attacker's process or object.

### 4. Network and output

Start commands with no network capabilities and no loopback exemptions; the trusted controller can use a local offline model fixture. An entire-SDK alternative would need the separate model IPC adapter. AppContainer network grants distinguish internet, private-network and server access, rather than being a destination allowlist. Package download and live development-server support require a separate egress design and tests against LAN/loopback access; adding internet capability for convenience is not that design. [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation), [loopback exemption API](https://learn.microsoft.com/en-us/windows/win32/api/networkisolation/nf-networkisolation-networkisolationsetappcontainerconfig)

After all sandbox writers have stopped, the host validates the complete result tree and creates a reviewable patch/export at a separate host-owned destination. Model-supplied output paths are not write authority. Preserve additions, edits, deletions and explicit errors; bound total bytes and file counts. Do not write or delete original project files. Automatic apply remains blocked until the all-writers coordination requirement in the copy-back design is demonstrated; a digest check followed by rename does not meet it.

## Acceptance gates on an actual Windows machine

Every gate needs the exact source commit, packaged runtime hashes, Windows build, filesystem, account privilege, grants and repeatable command/output. Use disposable canaries and synthetic tokens first; do not include their contents in published logs.

| Gate | Required demonstration |
|---|---|
| Launch and compatibility | Run real native file tools, shell and a small build/test under the proposed production launcher. Inspect the runtime and descendant tokens/capabilities/job membership. Unsupported OS or setup failure executes no tool. Validate Windows 10 22H2 and Windows 11 separately before claiming both. |
| Filesystem denial | Native file tools and native shell cannot read/write Ember canaries, the original project or another session via direct paths, pre-existing hardlinks, new aliases, junctions, reparse points, alternate streams, case/short-name aliases or swapped parents. Snapshot and export races cannot redirect host reads/writes or grants. |
| Secret separation | Shell/runtime scans find no synthetic broker token in environments, command lines, accessible memory, handles, pipes, dumps or persisted files. Attempts to open broker/Ember memory or duplicate privileged handles fail. Verify no secret appears in request failure/redirect/stream-cancellation logs. |
| Controller authority | Actual native SDK tools/plugins/hooks cannot execute; only custom tools under captured user words, account/project/mode and file grants can act. Stop/sign-out/Forget revoke old authority and await controller disposal. If the entire-SDK broker path is used, also reject wrong peers, replay, malformed messages, arbitrary destinations and cross-session pipes. |
| Descendants and Stop | Nested/detached children, breakaway flags, WMI/COM/service attempts and long-running writers cannot escape containment. Stop and launcher/broker crashes leave no active descendant or continuing output. Force timeout/failed termination: results stay unavailable and new coding stays blocked. |
| Egress and toolchain | Internet, LAN, host loopback, SMB and unapproved IPC are inaccessible in the initial mode. Selected compilers/tests work without host secrets, global caches or an expanded profile grant; failures are reported as limitations. |
| Export and recovery | Export handles supported changes and refuses hostile paths/objects; concurrent editing in the original project remains untouched. Test interruption at copy/export/cleanup, disk full, permissions, restart and two sessions. No automatic apply. |
| Live provider | After earlier gates pass, verify actual GitHub and BYOK authentication in the trusted controller, streaming, quota, error handling and cancellation. Prove project commands cannot obtain those credentials and the pinned SDK cannot enable native project execution. |

Remaining command work is the enforced command adapter, useful toolchain compatibility, exact fresh-copy package grants, verified stopped project-code writers, recovery ownership proof and any future controlled network access. The files-only owner, sealed review, export and continuation already have their separate evidence above. Broker transport is additional work only for the entire-SDK alternative. Windows CI can establish kernel and filesystem evidence; Windows 10/11 client acceptance remains separate. Passing Linux tests does not satisfy the Windows gates, and Windows success would not establish the corresponding Linux/macOS boundaries.
