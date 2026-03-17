import type { ServiceDefinition } from './types';

export const linear: ServiceDefinition = {
  config: {
    id: 'linear',
    name: 'Linear',
    authorizationUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scopes: ['read', 'write'],
    clientIdEnvKey: 'LINEAR_CLIENT_ID',
    clientSecretEnvKey: 'LINEAR_CLIENT_SECRET',
    mcpBaseUrl: 'https://mcp.linear.app/mcp',
    transport: 'streamable-http',
    usePKCE: true,
    apiKey: {
      inject: { type: 'header', name: 'Authorization' },
      proxyInject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },
      validate: {
        url: 'https://api.linear.app/graphql',
        method: 'POST',
        body: JSON.stringify({ query: '{ viewer { id } }' }),
        expectStatus: 200,
      },
      instructions: 'Click your workspace name (top-left) \u2192 Settings \u2192 Security and Access \u2192 Personal API Keys \u2192 New Key',
    },
  },
};
