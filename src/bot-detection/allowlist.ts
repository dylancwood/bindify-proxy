export function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw.split(',').map(ip => ip.trim()).filter(ip => ip.length > 0)
  );
}

export function isAllowlisted(allowlist: Set<string>, ip: string): boolean {
  return allowlist.has(ip);
}
