import type { ServiceDefinition } from './types';

export const atlassian: ServiceDefinition = {
  config: {
    id: 'atlassian',
    name: 'Atlassian',
    mcpBaseUrl: 'https://mcp.atlassian.com/v1/mcp',
    transport: 'streamable-http',
    apiKey: {
      inject: { type: 'header', name: 'Authorization', prefix: 'Basic ' },
      validate: {
        url: 'https://mcp.atlassian.com/v1/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'bindify', version: '1.0.0' },
          },
        }),
        expectStatus: 200,
      },
      instructions:
        'Prerequisites: Rovo must be enabled for your org, and your admin must enable API token auth at admin.atlassian.com > Apps > AI settings > Rovo MCP server > Enable API Key Authentication.',
      applications: [
        { id: 'jira', label: 'Jira', toolPattern: 'jira' },
        { id: 'confluence', label: 'Confluence', toolPattern: 'confluence' },
        { id: 'compass', label: 'Compass', toolPattern: 'compass' },
        { id: 'other', label: 'Other', toolPattern: '' },
      ],
      authModes: [
        {
          id: 'personal',
          label: 'Personal Token',
          fields: [
            { key: 'email', label: 'Atlassian Email', placeholder: 'your.email@example.com', type: 'text' as const },
            { key: 'token', label: 'API Token', placeholder: 'Paste your Atlassian API token', type: 'password' as const },
          ],
          assembleApiKey: (fields) => {
            const { email, token } = fields;
            try {
              const decoded = atob(token);
              if (decoded.startsWith(email + ':')) {
                return token;
              }
            } catch {
              // Not valid base64
            }
            return btoa(`${email}:${token}`);
          },
          inject: { type: 'header' as const, name: 'Authorization', prefix: 'Basic ' },
        },
        {
          id: 'service_account',
          label: 'Service Account Key',
          instructions: 'Navigate to admin.atlassian.com > Directory > Service Accounts > (Create Service Account if needed) > Select Service Account > Create Credentials > API Token > Set name, expiration (< 1 year) > Add all classic scopes for Jira and/or Confluence (or a subset if you know what you\'re doing).',
          fields: [
            { key: 'apiKey', label: 'Service Account API Key', placeholder: 'Paste your service account key', type: 'password' as const },
          ],
          inject: { type: 'header' as const, name: 'Authorization', prefix: 'Bearer ' },
        },
      ],
    },
  },
};
