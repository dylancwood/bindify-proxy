import type { ServiceDefinition } from './types';

export const notion: ServiceDefinition = {
  config: {
    id: 'notion',
    name: 'Notion',
    authorizationUrl: 'https://mcp.notion.com/authorize',
    tokenUrl: 'https://mcp.notion.com/token',
    scopes: [],
    mcpBaseUrl: 'https://mcp.notion.com/mcp',
    transport: 'streamable-http',
    usePKCE: true,
    useDCR: true,
    dcrRegistrationUrl: 'https://mcp.notion.com/register',
  },
};
