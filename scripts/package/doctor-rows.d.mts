// Types for doctor-rows.mjs (the unit tests import it).

export type DoctorRowStatus = "ok" | "warn" | "fail";
export interface DoctorReport {
  header: string | null;
  rows: { status: DoctorRowStatus; label: string; detail: string }[];
}

export declare function parseDoctorReport(text: string): DoctorReport;
export declare function parseExpectation(arg: string): { label: string; status: DoctorRowStatus };
export declare function checkDoctorRows(
  report: DoctorReport,
  expectations: { label: string; status: DoctorRowStatus }[],
  o?: { allowMissing?: boolean },
): { problems: string[]; notChecked: string[] };
