import type { ServiceDefinition } from './types';

export const todoist: ServiceDefinition = {
  config: {
    id: 'todoist',
    name: 'Todoist',
    authorizationUrl: 'https://todoist.com/oauth/authorize',
    tokenUrl: 'https://todoist.com/oauth/access_token',
    scopes: ['data:read_write'],
    clientIdEnvKey: 'TODOIST_CLIENT_ID',
    clientSecretEnvKey: 'TODOIST_CLIENT_SECRET',
    mcpBaseUrl: 'https://ai.todoist.net/mcp',
    transport: 'streamable-http',
    usePKCE: false,
    requiresRefresh: false,
    apiKey: {
      inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },
      validate: {
        url: 'https://api.todoist.com/api/v1/projects',
        method: 'GET',
        expectStatus: 200,
      },
      instructions: 'Go to todoist.com \u2192 Click your name in the top left \u2192 Settings \u2192 Integrations \u2192 Developer \u2192 API Token.',
    },
  },
};
