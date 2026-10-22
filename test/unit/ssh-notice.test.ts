import { describe, expect, it } from "vitest";
import { CIM_SCRIPT, linuxSshProcesses, parseCim, parsePs, parseWslReader, sshDestination, userSshProcessesWith, windowsArgv, WSL_READER, type NoticeDeps } from "../../app/main/remote/notice-ssh";

const ssh = (...a: string[]) => sshDestination(["ssh", ...a]);

describe("sshDestination over OpenSSH's option grammar (§2.7)", () => {
  it("finds the destination after options with and without values, glued or apart", () => {
    expect(ssh("build-01")).toEqual({ dest: "build-01" });
    expect(ssh("-v", "-p", "2222", "deploy@build-01")).toEqual({ dest: "deploy@build-01", port: 2222 });
    expect(ssh("-p2222", "-lroot", "build-01")).toEqual({ dest: "build-01", port: 2222, user: "root" });
    expect(ssh("-4Cv", "-e", "none", "build-01", "uptime")).toEqual({ dest: "build-01" });
    expect(ssh("--", "build-01")).toEqual({ dest: "build-01" });
    // ssh.c reads options after the destination too, until the command starts.
    expect(ssh("build-01", "-p", "2200", "ls", "-p", "9")).toEqual({ dest: "build-01", port: 2200 });
    expect(sshDestination(["/usr/bin/ssh", "build-01"])).toEqual({ dest: "build-01" });
    expect(sshDestination(["C:\\Windows\\System32\\OpenSSH\\ssh.exe", "build-01"])).toEqual({ dest: "build-01" });
  });

  it("carries -J, -i, -F and the allow-listed -o keys, and drops everything else (critique remote-20)", () => {
    expect(ssh("-J", "deploy@bastion,inner:2200", "-i", "~/.ssh/work_ed25519", "-F", "/home/ana/.ssh/work_config", "-o", "HostKeyAlias=build", "-oIdentitiesOnly yes", "-L", "8080:localhost:80", "-A", "-X", "-o", "ProxyCommand=nc %h %p", "-o", "ForwardAgent=yes", "build-01")).toEqual({
      dest: "build-01",
      jump: ["deploy@bastion", "inner:2200"],
      identityFiles: ["~/.ssh/work_ed25519"],
      configFile: "/home/ana/.ssh/work_config",
      options: { HostKeyAlias: "build", IdentitiesOnly: "yes" },
    });
    expect(ssh("-o", "hostname=10.0.0.5", "-o", "Port=2222", "x")).toEqual({ dest: "x", options: { HostName: "10.0.0.5", Port: "2222" } });
    // A relative key file can't be carried; the agent and the user's config still apply.
    expect(ssh("-i", "id_rsa", "build-01")).toEqual({ dest: "build-01" });
  });

  it("reads ssh:// destinations", () => {
    expect(ssh("ssh://deploy@build-01:2200")).toEqual({ dest: "deploy@build-01", port: 2200 });
    expect(ssh("-p", "22", "ssh://deploy@build-01:2200")).toEqual({ dest: "deploy@build-01", port: 22 });
  });

  it("offers nothing for runs that aren't a session: -V, -G, -O, -Q, -N, -W", () => {
    for (const a of [["-V"], ["-G", "build-01"], ["-O", "check", "build-01"], ["-Q", "cipher"], ["-N", "-L", "1:h:2", "build-01"], ["-W", "h:22", "bastion"], ["-fN", "build-01"]]) {
      expect(ssh(...a)).toBeNull();
    }
  });

  it("offers nothing when the route can't be reproduced safely or the host is unsafe", () => {
    expect(ssh()).toBeNull();
    expect(ssh("-p")).toBeNull();
    expect(ssh("-p", "99999", "build-01")).toBeNull();
    expect(ssh("-J", "bas%tion", "build-01")).toBeNull();
    expect(ssh("-F", "relative.cfg", "build-01")).toBeNull();
    expect(ssh("-o", "HostName=a b", "build-01")).toBeNull();
    expect(ssh("-Z", "build-01")).toBeNull();
    expect(ssh("--", "-oProxyCommand=x")).toBeNull();
    expect(ssh("host;id")).toBeNull();
    expect(sshDestination(["scp", "build-01"])).toBeNull();
    expect(sshDestination([])).toBeNull();
  });
});

describe("the user's own ssh processes (R4)", () => {
  const proc: Record<string, { comm: string; uid: number; cmdline: string }> = {
    "100": { comm: "ssh", uid: 1000, cmdline: "ssh\0-J\0bastion\0deploy@build-01\0" },
    "101": { comm: "bash", uid: 1000, cmdline: "bash\0" },
    "102": { comm: "ssh", uid: 1001, cmdline: "ssh\0someone@else\0" },
    "103": { comm: "ssh", uid: 1000, cmdline: "/usr/bin/ssh\0-T\0-o\0EscapeChar=none\0-o\0PermitLocalCommand=no\0--\0deploy@build-01\0sh\0-s\0" },
  };
  const deps = (over: Partial<NoticeDeps> = {}): NoticeDeps => ({
    readdir: () => ["self", "1", ...Object.keys(proc)],
    readFile: p => {
      const m = /^\/proc\/(\d+)\/(comm|cmdline)$/.exec(p);
      const e = m && proc[m[1]];
      return e ? Buffer.from(m[2] === "comm" ? `${e.comm}\n` : e.cmdline) : null;
    },
    ownerUid: p => proc[p.slice(6)]?.uid ?? null,
    uid: 1000,
    run: async () => ({ code: 1, stdout: "" }),
    ...over,
  });

  it("reads Linux's /proc for this user's ssh, never another user's and never Ember's own", () => {
    expect(linuxSshProcesses(deps())).toEqual([{ pid: 100, argv: ["ssh", "-J", "bastion", "deploy@build-01"], via: "local" }]);
    expect(linuxSshProcesses(deps({ readdir: () => { throw new Error("EACCES"); } }))).toBeNull();
  });

  it("reads macOS's ps for this user", async () => {
    const runs: (readonly string[])[] = [];
    const r = await userSshProcessesWith("darwin", deps({ run: async argv => { runs.push(argv); return { code: 0, stdout: "  501 ssh -p 2222 deploy@build-01\n  502 /bin/zsh\n  503 /usr/bin/ssh build-02\n" }; } }));
    expect(runs).toEqual([["/bin/ps", "-U", "1000", "-o", "pid=,args="]]);
    expect(r).toEqual([{ pid: 501, argv: ["ssh", "-p", "2222", "deploy@build-01"], via: "local" }, { pid: 503, argv: ["/usr/bin/ssh", "build-02"], via: "local" }]);
    expect(parsePs("garbage\n")).toEqual([]);
  });

  it("asks Windows once, by CIM, for this session's ssh.exe, and each running distro once (L22)", async () => {
    const runs: { argv: readonly string[]; input?: string }[] = [];
    const r = await userSshProcessesWith("win32", deps({
      systemRoot: "C:\\Windows",
      run: async (argv, o) => {
        runs.push({ argv, input: o.input });
        if (argv[0].endsWith("powershell.exe")) return { code: 0, stdout: `${JSON.stringify({ p: 77, c: "\"C:\\Windows\\System32\\OpenSSH\\ssh.exe\" -p 2222 deploy@build-01" })}\r\n` };
        return { code: 0, stdout: "900\tssh\u0001-J\u0001bastion\u0001build-03\u0001\n" };
      },
    }), { wsl: { exe: "C:\\Windows\\System32\\wsl.exe", distros: ["Ubuntu", "bad name;rm"] } });
    expect(runs[0].argv).toEqual(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", CIM_SCRIPT]);
    expect(runs[1]).toEqual({ argv: ["C:\\Windows\\System32\\wsl.exe", "-d", "Ubuntu", "--exec", "/bin/sh", "-s"], input: WSL_READER });
    expect(runs).toHaveLength(2);
    expect(r).toEqual([
      { pid: 77, argv: ["C:\\Windows\\System32\\OpenSSH\\ssh.exe", "-p", "2222", "deploy@build-01"], via: "local" },
      { pid: 900, argv: ["ssh", "-J", "bastion", "build-03"], via: "wsl:Ubuntu" },
    ]);
  });

  it("says null when the list can't be read", async () => {
    expect(await userSshProcessesWith("win32", deps({ run: async () => ({ code: 1, stdout: "" }) }))).toBeNull();
    expect(await userSshProcessesWith("darwin", deps({ uid: null }))).toBeNull();
  });

  it("splits Windows command lines as CommandLineToArgvW does", () => {
    expect(windowsArgv("ssh.exe -o \"ProxyJump=a b\" host")).toEqual(["ssh.exe", "-o", "ProxyJump=a b", "host"]);
    expect(windowsArgv("a\\\\\"b c\" d")).toEqual(["a\\b c", "d"]);
    expect(windowsArgv("a\\\"b")).toEqual(["a\"b"]);
    expect(windowsArgv("C:\\dir\\ssh.exe  x")).toEqual(["C:\\dir\\ssh.exe", "x"]);
    expect(windowsArgv("\"\"")).toEqual([""]);
    expect(parseCim("not json\n{\"p\":\"x\",\"c\":1}\n")).toEqual([]);
  });

  it("keeps the WSL reader's processes apart by distro", () => {
    expect(parseWslReader("12\tssh\u0001build\u0001\nnoise\n", "Debian")).toEqual([{ pid: 12, argv: ["ssh", "build"], via: "wsl:Debian" }]);
    expect(WSL_READER).not.toMatch(/[`]|eval/);
  });
});
