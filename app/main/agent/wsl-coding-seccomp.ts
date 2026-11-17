/** WSL2 commands retain Linux's process restrictions and permit only local Unix-domain sockets. */
export function wslCodingSeccomp(): Buffer {
  const rows: Buffer[] = [];
  const add = (op: number, yes: number, no: number, value: number) => {
    const row = Buffer.alloc(8); row.writeUInt16LE(op); row[2] = yes; row[3] = no; row.writeUInt32LE(value, 4); rows.push(row);
  };
  add(0x20, 0, 0, 4); add(0x15, 1, 0, 0xc000003e); add(0x06, 0, 0, 0x80000000);
  add(0x20, 0, 0, 0); add(0x45, 0, 1, 0x40000000); add(0x06, 0, 0, 0x80000000);
  // Exactly the existing Linux keyring/process-inspection restrictions; no native Windows policy is changed.
  for (const syscall of [248, 249, 250, 101, 310, 311, 312, 304, 298, 321, 323, 425, 434, 438]) {
    add(0x15, 0, 1, syscall); add(0x06, 0, 0, 0x00050001);
  }
  // A network namespace does not establish a Hyper-V/AF_VSOCK boundary. Also reject other unnecessary families.
  for (const syscall of [41, 53]) { // socket, socketpair
    add(0x15, 0, 7, syscall);
    add(0x20, 0, 0, 20); add(0x15, 1, 0, 0); add(0x06, 0, 0, 0x00050001);
    add(0x20, 0, 0, 16); add(0x15, 1, 0, 1); add(0x06, 0, 0, 0x00050001); add(0x06, 0, 0, 0x7fff0000);
  }
  add(0x06, 0, 0, 0x7fff0000);
  return Buffer.concat(rows);
}
