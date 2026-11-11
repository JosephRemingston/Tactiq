export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

/** Decodes (does not verify) a JWT so the page can show what the backend will receive. */
export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const part = (s: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0)))) as Record<string, unknown>;
    return { header: part(parts[0]!), claims: part(parts[1]!) };
  } catch {
    return null;
  }
}

/** Same token with a corrupted signature, to prove the backend rejects it. */
export function tamper(token: string): string {
  const [h, p, s] = token.split('.');
  return `${h}.${p}.${(s ?? '').slice(0, -4)}AAAA`;
}
