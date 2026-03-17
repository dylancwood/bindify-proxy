export interface RefreshConfig {
  refreshIntervalMinutes: number;
}

export const REFRESH_CONFIG: Record<string, RefreshConfig> = {
  atlassian: { refreshIntervalMinutes: 1440 },
  linear:    { refreshIntervalMinutes: 1440 },
  notion:    { refreshIntervalMinutes: 360 },
  github:    { refreshIntervalMinutes: 1440 },
  figma:     { refreshIntervalMinutes: 1440 },
  todoist:   { refreshIntervalMinutes: 1440 }, // keep-alive cadence (no token refresh — tokens don't expire)
};
