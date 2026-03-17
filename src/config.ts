export interface BindifyConfig {
  proxyCacheTtlSeconds: number;
  refreshLockTtlSeconds: number;
}

const DEFAULTS: BindifyConfig = {
  proxyCacheTtlSeconds: 3600,
  refreshLockTtlSeconds: 3,
};

export function parseConfig(raw: string | undefined): BindifyConfig {
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw);
    return {
      proxyCacheTtlSeconds: typeof parsed.proxyCacheTtlSeconds === 'number'
        ? parsed.proxyCacheTtlSeconds : DEFAULTS.proxyCacheTtlSeconds,
      refreshLockTtlSeconds: typeof parsed.refreshLockTtlSeconds === 'number'
        ? parsed.refreshLockTtlSeconds : DEFAULTS.refreshLockTtlSeconds,
    };
  } catch {
    return { ...DEFAULTS };
  }
}
