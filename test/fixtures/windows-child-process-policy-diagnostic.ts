/** Metadata only: no native calls, error text/property reads, handles, policy values or cleanup authority. */
export interface WindowsChildPolicyFailure {
  readonly schema: 1;
  /** 0 unknown, 1 IO constructor, 2 host, 3 LPAC, 4 proof/receipt, 5 stopped report, 6 cleanup. */
  readonly phase: number;
  /** 0 unknown; 1 attribute sizing, 2 attribute init, 3 attribute update, 4 CreateProcessW,
   * 5 GetProcessMitigationPolicy, 6 host job, 7 host create, 8 assign, 9 verify,
   * 10 pins, 11 resume, 12 natural exit/job zero, 13 exit code, 14 close, 15 birth-policy equality. */
  readonly operation: number;
  /** 0 unknown, 1 FALSE, 2 unexpected sizing result, 3 size contract, 4 handle-list attribute,
   * 5 capability attribute, 6 AAP attribute, 7 child-policy attribute, 8 policy domain,
   * 9 birth equality, 10 exception/contract, 11 terminal cleanup. */
  readonly predicate: number;
  /** 0 unknown/unvalidated return, 1 validated captured BOOL, 2 captured exit DWORD of this fixed admitted C asset. */
  readonly domain: 0 | 1 | 2;
  readonly returnedBool?: 0 | 1;
  /** Domain 2 only, mutually exclusive with returnedBool; never a PID, count, policy value or private output. */
  readonly returnedExit?: number;
}
type Context = Pick<WindowsChildPolicyFailure, "phase" | "operation" | "predicate">;
const failures = new WeakMap<object, { readonly receipt: Readonly<WindowsChildPolicyFailure>; readonly order: number }>();
let order = 0;
const object = (value: unknown): value is object => value !== null && typeof value === "object";
const bounded = (value: unknown, maximum: number) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
/** Returns the exact input error; a first valid brand can never be replaced by later facts. */
export function brandWindowsChildPolicyFailure<T>(error: T, context: Context, capturedBool?: unknown): T {
  if (!object(error) || failures.has(error) || !bounded(context.phase, 6) || !bounded(context.operation, 15) || !bounded(context.predicate, 11)) return error;
  const returnedBool = capturedBool === 0 || capturedBool === false ? 0 : capturedBool === 1 || capturedBool === true ? 1 : undefined;
  const receipt: Readonly<WindowsChildPolicyFailure> = Object.freeze({ schema: 1, phase: context.phase, operation: context.operation, predicate: context.predicate,
    domain: returnedBool === undefined ? 0 : 1, ...(returnedBool === undefined ? {} : { returnedBool }) });
  failures.set(error, { receipt, order: order++ }); return error;
}
/** The fixed hash-admitted witness's existing exit-code query only; never accepts coercions or adds a query. */
export function brandWindowsChildPolicyExitFailure<T>(error: T, context: Context, capturedExit: unknown): T {
  if (!object(error) || failures.has(error) || !bounded(context.phase, 6) || !bounded(context.operation, 15) || !bounded(context.predicate, 11)) return error;
  const returnedExit = bounded(capturedExit, 0xffffffff) ? capturedExit as number : undefined;
  const receipt: Readonly<WindowsChildPolicyFailure> = Object.freeze({ schema: 1, phase: context.phase, operation: context.operation, predicate: context.predicate,
    domain: returnedExit === undefined ? 0 : 2, ...(returnedExit === undefined ? {} : { returnedExit }) });
  failures.set(error, { receipt, order: order++ }); return error;
}
/** Copies only the earliest branded facts, preserving the target's authoritative identity and type. */
export function preserveWindowsChildPolicyFailure<T>(source: unknown, target: T): T {
  if (!object(source) || !object(target)) return target;
  const first = failures.get(source), current = failures.get(target);
  if (first && (!current || first.order < current.order)) failures.set(target, first);
  return target;
}
/** Similar-looking objects, inherited properties and arbitrary errors never yield diagnostic output. */
export function windowsChildPolicyFailure(error: unknown): Readonly<WindowsChildPolicyFailure> | undefined {
  return object(error) ? failures.get(error)?.receipt : undefined;
}
