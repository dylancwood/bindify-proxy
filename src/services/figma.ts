import type { ServiceDefinition } from './types';

export const figma: ServiceDefinition = {
  config: {
    id: 'figma',
    name: 'Figma',
    authorizationUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://api.figma.com/v1/oauth/token',
    scopes: [
      'current_user:read',
      'file_content:read',
      'file_metadata:read',
      'file_comments:read',
      'file_comments:write',
      'file_versions:read',
      'file_dev_resources:read',
      'file_dev_resources:write',
      'library_assets:read',
      'library_content:read',
      'team_library_content:read',
      'webhooks:read',
      'webhooks:write',
    ],
    clientIdEnvKey: 'FIGMA_CLIENT_ID',
    clientSecretEnvKey: 'FIGMA_CLIENT_SECRET',
    mcpBaseUrl: 'https://api.figma.com/mcp',
    transport: 'streamable-http',
    usePKCE: false,
    apiKey: {
      inject: { type: 'header', name: 'X-Figma-Token' },
      validate: {
        url: 'https://api.figma.com/v1/me',
        method: 'GET',
        expectStatus: 200,
      },
      instructions: 'Go to figma.com \u2192 Settings \u2192 Account \u2192 Personal access tokens \u2192 Generate new token.',
    },
  },
};
