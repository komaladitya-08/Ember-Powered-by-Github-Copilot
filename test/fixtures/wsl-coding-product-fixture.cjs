/** Own the dedicated CI distro for exactly the proof child lifetime. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("node:child_process");

async function waitFor(event, timeout) {
  let timer;
  try {
    return await Promise.race([event, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("The WSL qualification fixture did not respond.")), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function withWslProductFixture(run) {
  // The two bytes verify the guest pipe before and after the proof. EOF releases cat.
  const child = spawn("wsl.exe", ["-d", "Ubuntu-22.04", "-u", "ember", "--cd", "/", "--exec", "/bin/cat"], {
    env: { ...process.env, WSLENV: "", WSL_UTF8: "1" }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve(code === 0 && signal === null)));
  const ready = Promise.withResolvers(), receipt = Promise.withResolvers();
  let expected = "R", broken = false;
  const fail = () => {
    broken = true;
    ready.resolve(false);
    receipt.resolve(false);
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stdout.on("data", bytes => {
    if (broken || bytes.length !== 1 || bytes.toString("latin1") !== expected) {
      fail();
      return;
    }
    const response = expected;
    expected = "";
    (response === "R" ? ready : receipt).resolve(true);
  });
  const release = async () => {
    let acknowledged = false;
    if (!broken) {
      expected = "C";
      child.stdin.write("C");
      acknowledged = await Promise.race([receipt.promise, closed.then(() => false)]);
    }
    if (!child.stdin.destroyed) child.stdin.end();
    return await closed && !broken && acknowledged;
  };
  try {
    child.stdin.write("R");
    if (!await waitFor(Promise.race([ready.promise, closed.then(() => false)]), 15_000) || broken) {
      throw new Error("The WSL qualification fixture failed to start.");
    }
    let held;
    try { run(); }
    finally {
      held = await waitFor(release(), 5_000).catch(() => false);
    }
    if (!held) throw new Error("The WSL qualification fixture did not stay open through the proof.");
  } finally {
    fail();
    child.stdin.destroy();
    child.stdout.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

module.exports = { withWslProductFixture };
