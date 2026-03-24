import type { ServiceDefinition } from './types';

export const ticktick: ServiceDefinition = {
  config: {
    id: 'ticktick',
    name: 'TickTick',
    authorizationUrl: 'https://ticktick.com/oauth/authorize',
    tokenUrl: 'https://api.ticktick.com/oauth/token',
    scopes: ['tasks:read', 'tasks:write'],
    mcpBaseUrl: 'https://mcp.ticktick.com/mcp',
    transport: 'streamable-http',
    usePKCE: true,
    useDCR: true,
    dcrRegistrationUrl: 'https://api.ticktick.com/oauth/register',
    apiKey: {
      inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },
      validate: {
        url: 'https://api.ticktick.com/open/v1/project',
        method: 'GET',
        expectStatus: 200,
      },
      instructions:
        'Click profile avatar on top-left nav → Settings → API Token (Manage) → Copy',
    },
  },
};
