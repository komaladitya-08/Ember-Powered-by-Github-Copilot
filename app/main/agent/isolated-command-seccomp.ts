/** Linux x64 command policy. Other architectures fail closed before a copied command is admitted. */
export function isolatedCommandSeccomp(): Buffer {
  const code: Buffer[] = [];
  const add = (op: number, yes: number, no: number, value: number) => { const b = Buffer.alloc(8); b.writeUInt16LE(op); b[2] = yes; b[3] = no; b.writeUInt32LE(value, 4); code.push(b); };
  add(0x20, 0, 0, 4); add(0x15, 1, 0, 0xc000003e); add(0x06, 0, 0, 0x80000000);
  add(0x20, 0, 0, 0); add(0x45, 0, 1, 0x40000000); add(0x06, 0, 0, 0x80000000);
  // A new user/PID/terminal session does not discard an inherited session keyring. Offline commands need no key API.
  // add_key, request_key, keyctl; retain the existing process-inspection denials below them.
  for (const syscall of [248, 249, 250, 101, 310, 311, 312, 304, 298, 321, 323, 425, 434, 438]) { add(0x15, 0, 1, syscall); add(0x06, 0, 0, 0x00050001); }
  add(0x06, 0, 0, 0x7fff0000);
  return Buffer.concat(code);
}
