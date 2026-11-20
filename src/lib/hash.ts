/** Non-cryptographic helpers for ids and cache keys. */

/** cyrb53: a fast, well-distributed 53-bit string hash, returned as hex. */
export function hashString(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export function randomId(prefix = ''): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return prefix ? `${prefix}_${id}` : id;
}
