/** Private synchronous token-buffer decoding. No pointer, SID or token data is diagnostic/public authority. */
export function windowsCommandCreatorTokenSid(bytes: Buffer, returned: unknown, base: unknown, kind: 1 | 4 | 31): string {
  const refuse = () => new Error("The creator token buffer failed its bounded SID contract.");
  const header = kind === 1 ? 16 : 8;
  if (!Buffer.isBuffer(bytes) || typeof returned !== "number" || !Number.isInteger(returned) || returned < header + 8 || returned > bytes.length ||
      typeof base !== "bigint" || base <= 0n || base >= 0x8000000000000000n || base + BigInt(returned) >= 0x8000000000000000n) throw refuse();
  const sid = bytes.readBigUInt64LE(0), offset = sid - base;
  if (sid % 4n !== 0n || offset < BigInt(header) || offset > BigInt(returned - 8)) throw refuse();
  const at = Number(offset), count = bytes[at + 1], length = 8 + count * 4;
  if (bytes[at] !== 1 || count < 1 || count > 15 || length > returned - at) throw refuse();
  let authority = 0n; for (let i = 0; i < 6; i++) authority = (authority << 8n) | BigInt(bytes[at + 2 + i]);
  const parts = Array.from({ length: count }, (_, i) => bytes.readUInt32LE(at + 8 + i * 4));
  // The source handles actual Windows user/package authorities; high authorities remain private and fail exact comparison.
  return `S-1-${authority.toString()}-${parts.join("-")}`;
}
