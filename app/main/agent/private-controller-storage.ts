/** Host-owned trusted-controller storage. Cleanup is called only after the SDK child has verifiably exited. */
export interface PrivateControllerPaths { root: string; cwd: string; home: string; state: string; temporary: string }
export interface PrivateControllerStorage {
  readonly paths: PrivateControllerPaths;
  /** Fixed private paths must still name the exact allocated objects before/after SDK startup. */
  verify(): void | Promise<void>;
  /** Mark disposal uncertain before awaiting SDK stop, so another controller cannot pass this owner. */
  retire(): void;
  /** Await every owned native cleanup operation. Failure retains the terminal storage owner. */
  close(): Promise<void>;
}
