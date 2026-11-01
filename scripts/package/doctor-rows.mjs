// Reads the report `ember --doctor` prints (formatDoctor in app/main/doctor.ts: "<mark>  <label padded>  <detail>"
// lines, the mark "ok", "warn" or "FAIL") back into rows, and checks the status of named rows. CI's macOS job runs the
// packaged Ember through LaunchServices, so that Ember.app is its own responsible process to TCC, before and after its
// grant is written, and expects the "Accessibility" and "Accessibility helper" rows to fail and then to pass: proof
// that nothing is borrowed from the runner's already-granted processes and that the grant reaches Ember and its
// helper. A report without a single row fails every check, whatever the options say: an Ember that crashed or printed
// nothing proves nothing. --allow-missing-rows lets a named row that the report doesn't have yet pass with a warning
// (the macOS rows come with the port's later packages); a row that is there with the wrong status always fails.
// usage: node scripts/package/doctor-rows.mjs <report file> <label>=<ok|warn|fail>... [--allow-missing-rows]
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** The statuses a row can have, as formatDoctor marks them. */
const MARKS = { "ok  ": "ok", warn: "warn", FAIL: "fail" };

/**
 * A row: its mark, two spaces, the label (words joined by single spaces) padded with spaces to the widest label, two
 * spaces, the detail. The widest label is followed by exactly two spaces, the others by more.
 */
const ROW = /^(ok {2}|warn|FAIL) {2}(\S+(?: \S+)*?)(?: {2,}(.*))?$/;

/**
 * The header ("Ember 0.1.0 check-up") and the rows of a doctor report. Fix lines ("→ …"), blank lines and the closing
 * summary are not rows.
 * @param {string} text
 * @returns {{ header: string | null; rows: { status: "ok" | "warn" | "fail"; label: string; detail: string }[] }}
 */
export function parseDoctorReport(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  // "setup check" since the window's name was given to the report too ("check-up" before).
  const header = lines.find(l => /^Ember \S+ (?:setup check|check-up)$/.test(l.trim()))?.trim() ?? null;
  const rows = [];
  for (const line of lines) {
    const m = ROW.exec(line.replace(/\s+$/, ""));
    if (m) rows.push({ status: MARKS[m[1]], label: m[2], detail: m[3] ?? "" });
  }
  return { header, rows };
}

/**
 * "Accessibility helper=fail" → { label: "Accessibility helper", status: "fail" }.
 * @param {string} arg
 */
export function parseExpectation(arg) {
  const m = /^(.+?)=(ok|warn|fail)$/.exec(String(arg));
  if (!m || !m[1].trim()) throw new Error(`expected <label>=<ok|warn|fail>, not ${JSON.stringify(arg)}`);
  return { label: m[1].trim(), status: /** @type {"ok" | "warn" | "fail"} */ (m[2]) };
}

/**
 * Checks the rows `expectations` name. `problems` fail the check; `notChecked` lists the named rows the report
 * doesn't have when `allowMissing` lets them pass (without it they are problems).
 * @param {ReturnType<typeof parseDoctorReport>} report
 * @param {{ label: string; status: "ok" | "warn" | "fail" }[]} expectations
 * @param {{ allowMissing?: boolean }} [o]
 */
export function checkDoctorRows(report, expectations, o = {}) {
  const problems = [], notChecked = [];
  if (!report.rows.length) {
    problems.push("the report has no rows (Ember printed no check-up)");
    return { problems, notChecked };
  }
  if (!expectations.length) problems.push("no rows to check");
  for (const want of expectations) {
    const rows = report.rows.filter(r => r.label === want.label);
    if (rows.length > 1) problems.push(`"${want.label}" appears ${rows.length} times`);
    else if (!rows.length) {
      if (o.allowMissing) notChecked.push(want.label);
      else problems.push(`no "${want.label}" row (rows: ${report.rows.map(r => r.label).join(", ")})`);
    } else if (rows[0].status !== want.status) {
      problems.push(`"${want.label}" is ${rows[0].status}, should be ${want.status}: ${rows[0].detail}`);
    }
  }
  return { problems, notChecked };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const allowMissing = args.includes("--allow-missing-rows");
  const [file, ...rest] = args.filter(a => a !== "--allow-missing-rows");
  let expectations;
  try {
    if (!file || !rest.length) throw new Error("name a report file and at least one row");
    expectations = rest.map(parseExpectation);
  } catch (err) {
    console.error(`${err.message}\nusage: node scripts/package/doctor-rows.mjs <report file> <label>=<ok|warn|fail>... [--allow-missing-rows]`);
    process.exit(2);
  }
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const report = parseDoctorReport(text);
  console.log(`${file}: ${report.header ?? "no check-up header"}, ${report.rows.length} rows`);
  for (const r of report.rows) console.log(`  ${r.status.padEnd(4)}  ${r.label}: ${r.detail}`);
  const { problems, notChecked } = checkDoctorRows(report, expectations, { allowMissing });
  const annotate = process.env.GITHUB_ACTIONS === "true";
  for (const label of notChecked) console.warn(`${annotate ? "::warning::" : "warning: "}${file}: no "${label}" row yet, so it isn't checked (--allow-missing-rows)`);
  for (const p of problems) console.error(`${annotate ? "::error::" : "FAIL "}${file}: ${p}`);
  if (problems.length && !report.rows.length && text.trim()) console.error(text);
  process.exit(problems.length ? 1 : 0);
}
