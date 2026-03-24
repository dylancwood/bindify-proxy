import { describe, it, expect } from 'vitest';
import { getService, getAllServices } from '../services/registry';
import { validateUpstreamApiKey } from '../api/validate-api-key';
import { REFRESH_CONFIG } from '../services/refresh-config';
import { handleListServices } from '../api/services-api';

describe('Service Registry', () => {
  it('returns config for linear', () => {
    const svc = getService('linear');
    expect(svc).not.toBeNull();
    expect(svc!.config.id).toBe('linear');
    expect(svc!.config.mcpBaseUrl).toBe('https://mcp.linear.app/mcp');
    expect(svc!.config.transport).toBe('streamable-http');
    expect(svc!.config.usePKCE).toBe(true);
  });

  it('returns config for todoist', () => {
    const svc = getService('todoist');
    expect(svc).not.toBeNull();
    expect(svc!.config.id).toBe('todoist');
    expect(svc!.config.mcpBaseUrl).toBe('https://ai.todoist.net/mcp');
    expect(svc!.config.transport).toBe('streamable-http');
    expect(svc!.config.usePKCE).toBe(false);
  });

  it('todoist does not require refresh', () => {
    const svc = getService('todoist')!;
    expect(svc.config.requiresRefresh).toBe(false);
  });

  it('todoist is in REFRESH_CONFIG for keep-alive', () => {
    expect(REFRESH_CONFIG).toHaveProperty('todoist');
    expect(REFRESH_CONFIG.todoist.refreshIntervalMinutes).toBe(1440);
  });

  it('returns config for atlassian', () => {
    const svc = getService('atlassian');
    expect(svc).not.toBeNull();
    expect(svc!.config.id).toBe('atlassian');
    expect(svc!.config.mcpBaseUrl).toBe('https://mcp.atlassian.com/v1/mcp');
    expect(svc!.config.transport).toBe('streamable-http');
    expect(svc!.overrides).toBeUndefined();
  });

  it('atlassian is api-key-only (no OAuth config)', () => {
    const svc = getService('atlassian')!;
    expect(svc.config.apiKey).toBeDefined();
    expect(svc.config.authorizationUrl).toBeUndefined();
    expect(svc.config.tokenUrl).toBeUndefined();
    expect(svc.config.scopes).toBeUndefined();
    expect(svc.config.clientIdEnvKey).toBeUndefined();
    expect(svc.config.clientSecretEnvKey).toBeUndefined();
  });

  it('returns config for notion', () => {
    const svc = getService('notion');
    expect(svc).not.toBeNull();
    expect(svc!.config.id).toBe('notion');
    expect(svc!.config.mcpBaseUrl).toBe('https://mcp.notion.com/mcp');
    expect(svc!.config.transport).toBe('streamable-http');
    expect(svc!.config.usePKCE).toBe(true);
    expect(svc!.config.useDCR).toBe(true);
    expect(svc!.config.dcrRegistrationUrl).toBe('https://mcp.notion.com/register');
  });

  it('returns config for ticktick', () => {
    const svc = getService('ticktick');
    expect(svc).not.toBeNull();
    expect(svc!.config.id).toBe('ticktick');
    expect(svc!.config.mcpBaseUrl).toBe('https://mcp.ticktick.com/mcp');
    expect(svc!.config.transport).toBe('streamable-http');
    expect(svc!.config.usePKCE).toBe(true);
    expect(svc!.config.useDCR).toBe(true);
    expect(svc!.config.dcrRegistrationUrl).toBe('https://api.ticktick.com/oauth/register');
  });

  it('ticktick has DCR OAuth + API key (both supported)', () => {
    const svc = getService('ticktick')!;
    expect(svc.config.apiKey).toBeDefined();
    expect(svc.config.apiKey!.inject).toEqual({ type: 'header', name: 'Authorization', prefix: 'Bearer ' });
    expect(svc.config.apiKey!.validate.url).toBe('https://api.ticktick.com/open/v1/project');
    expect(svc.config.apiKey!.validate.method).toBe('GET');
    expect(svc.config.apiKey!.instructions).toContain('API Token');
    expect(svc.config.clientIdEnvKey).toBeUndefined();
    expect(svc.config.clientSecretEnvKey).toBeUndefined();
    expect(svc.config.authorizationUrl).toBe('https://ticktick.com/oauth/authorize');
    expect(svc.config.tokenUrl).toBe('https://api.ticktick.com/oauth/token');
  });

  it('ticktick is in REFRESH_CONFIG for keep-alive', () => {
    expect(REFRESH_CONFIG).toHaveProperty('ticktick');
    expect(REFRESH_CONFIG.ticktick.refreshIntervalMinutes).toBe(1440);
  });

  it('returns config for github', () => {
    const svc = getService('github');
    expect(svc).not.toBeNull();
    expect(svc!.config.id).toBe('github');
    expect(svc!.config.mcpBaseUrl).toBe('https://api.githubcopilot.com/mcp');
  });

  it('linear has apiKey config', () => {
    const svc = getService('linear')!;
    expect(svc.config.apiKey).toBeDefined();
    expect(svc.config.apiKey!.inject).toEqual({ type: 'header', name: 'Authorization' });
    expect(svc.config.apiKey!.validate.url).toBe('https://api.linear.app/graphql');
    expect(svc.config.apiKey!.validate.method).toBe('POST');
    expect(svc.config.apiKey!.instructions).toContain('Settings');
  });

  it('github has apiKey config', () => {
    const svc = getService('github')!;
    expect(svc.config.apiKey).toBeDefined();
    expect(svc.config.apiKey!.inject).toEqual({ type: 'header', name: 'Authorization', prefix: 'Bearer ' });
    expect(svc.config.apiKey!.validate.url).toBe('https://api.github.com/user');
    expect(svc.config.apiKey!.validate.method).toBe('GET');
    expect(svc.config.apiKey!.instructions).toContain('Settings');
  });

  it('notion is DCR-OAuth-only (no API key, no static clientIdEnvKey)', () => {
    const svc = getService('notion')!;
    expect(svc.config.apiKey).toBeUndefined();
    expect(svc.config.clientIdEnvKey).toBeUndefined();
    expect(svc.config.clientSecretEnvKey).toBeUndefined();
    expect(svc.config.authorizationUrl).toBe('https://mcp.notion.com/authorize');
    expect(svc.config.tokenUrl).toBe('https://mcp.notion.com/token');
  });

  it('todoist has apiKey config', () => {
    const svc = getService('todoist')!;
    expect(svc.config.apiKey).toBeDefined();
    expect(svc.config.apiKey!.inject).toEqual({ type: 'header', name: 'Authorization', prefix: 'Bearer ' });
    expect(svc.config.apiKey!.validate.url).toBe('https://api.todoist.com/api/v1/projects');
    expect(svc.config.apiKey!.validate.method).toBe('GET');
    expect(svc.config.apiKey!.instructions).toContain('Settings');
  });

  it('figma has apiKey config', () => {
    const svc = getService('figma')!;
    expect(svc.config.apiKey).toBeDefined();
    expect(svc.config.apiKey!.inject).toEqual({ type: 'header', name: 'X-Figma-Token' });
    expect(svc.config.apiKey!.validate.url).toBe('https://api.figma.com/v1/me');
    expect(svc.config.apiKey!.validate.method).toBe('GET');
    expect(svc.config.apiKey!.instructions).toContain('Personal access tokens');
  });

  it('atlassian has apiKey config with Basic auth', () => {
    const svc = getService('atlassian')!;
    expect(svc.config.apiKey).toBeDefined();
    expect(svc.config.apiKey!.inject).toEqual({ type: 'header', name: 'Authorization', prefix: 'Basic ' });
    expect(svc.config.apiKey!.validate.url).toBe('https://mcp.atlassian.com/v1/mcp');
    expect(svc.config.apiKey!.validate.method).toBe('POST');
    expect(svc.config.apiKey!.instructions).toContain('Rovo');
  });

  it('atlassian has no top-level fields or assembleApiKey (moved to authModes)', () => {
    const svc = getService('atlassian')!;
    expect(svc.config.apiKey!.fields).toBeUndefined();
    expect(svc.config.apiKey!.assembleApiKey).toBeUndefined();
  });

  it('atlassian has authModes with personal and service_account', () => {
    const svc = getService('atlassian')!;
    const modes = svc.config.apiKey!.authModes!;
    expect(modes).toHaveLength(2);
    expect(modes[0].id).toBe('personal');
    expect(modes[0].label).toBe('Personal Token');
    expect(modes[1].id).toBe('service_account');
    expect(modes[1].label).toBe('Service Account Key');
  });

  it('atlassian personal mode has email and token fields with Basic inject', () => {
    const svc = getService('atlassian')!;
    const personal = svc.config.apiKey!.authModes![0];
    expect(personal.fields).toHaveLength(2);
    expect(personal.fields![0].key).toBe('email');
    expect(personal.fields![1].key).toBe('token');
    expect(personal.inject).toEqual({ type: 'header', name: 'Authorization', prefix: 'Basic ' });
    expect(personal.assembleApiKey).toBeDefined();
  });

  it('atlassian personal mode assembleApiKey base64-encodes email:token', () => {
    const svc = getService('atlassian')!;
    const personal = svc.config.apiKey!.authModes![0];
    const result = personal.assembleApiKey!({ email: 'user@example.com', token: 'mytoken123' });
    expect(result).toBe(btoa('user@example.com:mytoken123'));
  });

  it('atlassian service_account mode has single apiKey field with Bearer inject', () => {
    const svc = getService('atlassian')!;
    const sa = svc.config.apiKey!.authModes![1];
    expect(sa.fields).toHaveLength(1);
    expect(sa.fields![0].key).toBe('apiKey');
    expect(sa.fields![0].type).toBe('password');
    expect(sa.inject).toEqual({ type: 'header', name: 'Authorization', prefix: 'Bearer ' });
    expect(sa.assembleApiKey).toBeUndefined();
  });

  it('returns null for unknown service', () => {
    const svc = getService('unknown');
    expect(svc).toBeNull();
  });

  it('getAllServices returns all 7 services', () => {
    const all = getAllServices();
    expect(all).toHaveLength(7);
    const ids = all.map(s => s.config.id).sort();
    expect(ids).toEqual(['atlassian', 'figma', 'github', 'linear', 'notion', 'ticktick', 'todoist']);
  });

  it('service with apiKey config has required fields', () => {
    const all = getAllServices();
    for (const svc of all) {
      if (svc.config.apiKey) {
        expect(svc.config.apiKey.inject).toBeDefined();
        expect(svc.config.apiKey.validate).toBeDefined();
        expect(svc.config.apiKey.validate.url).toBeTruthy();
        expect(svc.config.apiKey.validate.method).toBeTruthy();
        expect(svc.config.apiKey.validate.expectStatus).toBeGreaterThan(0);
        expect(typeof svc.config.apiKey.instructions).toBe('string');
        expect(svc.config.apiKey.instructions.length).toBeGreaterThan(0);
      }
    }
  });

  it.skip('todoist accepts valid API key (integration)', async () => {
    const svc = getService('todoist')!;
    const result = await validateUpstreamApiKey('REPLACE_WITH_VALID_TOKEN', svc.config.apiKey!);
    expect(result.valid).toBe(true);
    expect(result.status).toBe(200);
  }, 10_000);

  it.skip('todoist rejects invalid API key (integration)', async () => {
    const svc = getService('todoist')!;
    const result = await validateUpstreamApiKey('invalid-token-12345', svc.config.apiKey!);
    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
  }, 10_000);

});

describe('Services API', () => {
  it('includes authModes for atlassian', async () => {
    const response = handleListServices();
    const data = await response.json() as any;
    const atlassianSvc = data.services.find((s: any) => s.id === 'atlassian');
    expect(atlassianSvc.authModes).toHaveLength(2);
    expect(atlassianSvc.authModes[0]).toEqual({
      id: 'personal',
      label: 'Personal Token',
      instructions: null,
      fields: [
        { key: 'email', label: 'Atlassian Email', placeholder: 'your.email@example.com', type: 'text' },
        { key: 'token', label: 'API Token', placeholder: 'Paste your Atlassian API token', type: 'password' },
      ],
    });
    expect(atlassianSvc.authModes[1]).toEqual({
      id: 'service_account',
      label: 'Service Account Key',
      instructions: expect.stringContaining('admin.atlassian.com'),
      fields: [
        { key: 'apiKey', label: 'Service Account API Key', placeholder: 'Paste your service account key', type: 'password' },
      ],
    });
  });

  it('does not include authModes for services without them', async () => {
    const response = handleListServices();
    const data = await response.json() as any;
    const linearSvc = data.services.find((s: any) => s.id === 'linear');
    expect(linearSvc.authModes).toBeNull();
  });
});
