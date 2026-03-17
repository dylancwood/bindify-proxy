import type { ServiceDefinition } from './types';

export const github: ServiceDefinition = {
  config: {
    id: 'github',
    name: 'GitHub',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user', 'read:org'],
    clientIdEnvKey: 'GITHUB_CLIENT_ID',
    clientSecretEnvKey: 'GITHUB_CLIENT_SECRET',
    mcpBaseUrl: 'https://api.githubcopilot.com/mcp',
    transport: 'streamable-http',
    usePKCE: false,
    apiKey: {
      inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },
      validate: {
        url: 'https://api.github.com/user',
        method: 'GET',
        expectStatus: 200,
        headers: { 'User-Agent': 'Bindify' },
      },
      instructions: 'Go to github.com \u2192 Settings \u2192 Developer settings \u2192 Personal access tokens \u2192 Generate new token.',
    },
  },
};
