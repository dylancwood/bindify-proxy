import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { validateUpstreamApiKey, buildUpstreamRequest } from '../api/validate-api-key';
import type { ApiKeyConfig } from '../services/types';
import { linear } from '../services/linear';
import { atlassian } from '../services/atlassian';

const LINEAR_TEST_API_KEY = (env as Record<string, string>).LINEAR_TEST_API_KEY;

const headerConfig: ApiKeyConfig = {
  inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },
  validate: { url: 'https://api.example.com/me', method: 'GET', expectStatus: 200 },
  instructions: 'Go to settings',
};

const queryConfig: ApiKeyConfig = {
  inject: { type: 'query', name: 'api_key' },
  validate: { url: 'https://api.example.com/me', method: 'GET', expectStatus: 200 },
  instructions: 'Go to settings',
};

describe('buildUpstreamRequest', () => {
  it('builds header injection correctly', () => {
    const { url, init } = buildUpstreamRequest('test-key', headerConfig);
    expect(url).toBe('https://api.example.com/me');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
  });

  it('builds header injection without prefix', () => {
    const noPrefix: ApiKeyConfig = {
      ...headerConfig,
      inject: { type: 'header', name: 'X-API-Key' },
    };
    const { init } = buildUpstreamRequest('test-key', noPrefix);
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('test-key');
  });

  it('builds query injection correctly', () => {
    const { url } = buildUpstreamRequest('test-key', queryConfig);
    expect(url).toBe('https://api.example.com/me?api_key=test-key');
  });

  it('merges extra validate headers', () => {
    const withHeaders: ApiKeyConfig = {
      ...headerConfig,
      validate: { ...headerConfig.validate, headers: { 'Notion-Version': '2022-06-28' } },
    };
    const { init } = buildUpstreamRequest('test-key', withHeaders);
    expect((init.headers as Record<string, string>)['Notion-Version']).toBe('2022-06-28');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
  });

  it('includes body and Content-Type when configured', () => {
    const withBody: ApiKeyConfig = {
      ...headerConfig,
      validate: { ...headerConfig.validate, method: 'POST', body: '{"query":"{ viewer { id } }"}' },
    };
    const { init } = buildUpstreamRequest('test-key', withBody);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"query":"{ viewer { id } }"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('adds default Accept header for POST-with-body', () => {
    const withBody: ApiKeyConfig = {
      ...headerConfig,
      validate: { ...headerConfig.validate, method: 'POST', body: '{}' },
    };
    const { init } = buildUpstreamRequest('test-key', withBody);
    expect((init.headers as Record<string, string>)['Accept']).toBe('application/json, text/event-stream');
  });

  it('allows validate.headers to override default Accept', () => {
    const withCustomAccept: ApiKeyConfig = {
      ...headerConfig,
      validate: {
        ...headerConfig.validate,
        method: 'POST',
        body: '{}',
        headers: { 'Accept': 'application/json' },
      },
    };
    const { init } = buildUpstreamRequest('test-key', withCustomAccept);
    expect((init.headers as Record<string, string>)['Accept']).toBe('application/json');
  });
});

describe('validateUpstreamApiKey', () => {
  it('returns valid result for valid API key', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    const result = await validateUpstreamApiKey('test-key', headerConfig, mockFetch);
    expect(result.valid).toBe(true);
    expect(result.status).toBe(200);
  });

  it('returns invalid with status when upstream rejects', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 401 });
    const result = await validateUpstreamApiKey('bad-key', headerConfig, mockFetch);
    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe('Upstream returned 401');
  });

  it('returns invalid with error message on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network'));
    const result = await validateUpstreamApiKey('test-key', headerConfig, mockFetch);
    expect(result.valid).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.error).toBe('Upstream request failed: network');
  });
});

describe('Linear API key config', () => {
  it('builds request with Authorization header without Bearer prefix', () => {
    const config = linear.config.apiKey!;
    const { url, init } = buildUpstreamRequest('lin_api_test123', config);

    expect(url).toBe('https://api.linear.app/graphql');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('lin_api_test123');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ query: '{ viewer { id } }' }));
  });

  it('returns invalid when Linear returns 401 for bad key', async () => {
    const config = linear.config.apiKey!;
    const mockFetch = vi.fn().mockResolvedValue({ status: 401 });

    const result = await validateUpstreamApiKey('lin_api_invalid', config, mockFetch);

    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe('Upstream returned 401');

    // Verify the request was built correctly
    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe('https://api.linear.app/graphql');
    expect((calledInit.headers as Record<string, string>)['Authorization']).toBe('lin_api_invalid');
  });

  it.skipIf(!LINEAR_TEST_API_KEY)('linear accepts valid API key (integration)', async () => {
    const config = linear.config.apiKey!;
    const result = await validateUpstreamApiKey(LINEAR_TEST_API_KEY!, config);
    expect(result.valid).toBe(true);
    expect(result.status).toBe(200);
  }, 10_000);

  it.skipIf(!LINEAR_TEST_API_KEY)('linear rejects invalid API key (integration)', async () => {
    const config = linear.config.apiKey!;
    const result = await validateUpstreamApiKey('lin_api_invalid_key_12345', config);
    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
  }, 10_000);
});

describe('Atlassian API key config', () => {
  it('builds request with Basic auth header', () => {
    const config = atlassian.config.apiKey!;
    const encoded = btoa('user@example.com:token123');
    const { url, init } = buildUpstreamRequest(encoded, config);

    expect(url).toBe('https://mcp.atlassian.com/v1/mcp');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Basic ${encoded}`);
    expect((init.headers as Record<string, string>)['Accept']).toBe('application/json, text/event-stream');
    expect(init.body).toBeDefined();
  });
});

describe('Atlassian auth modes validation', () => {
  it('builds request with Bearer header for service_account mode', () => {
    const config = atlassian.config.apiKey!;
    const mode = config.authModes!.find(m => m.id === 'service_account')!;
    const { url, init } = buildUpstreamRequest('my-service-key', config, mode);

    expect(url).toBe('https://mcp.atlassian.com/v1/mcp');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer my-service-key');
  });

  it('builds request with Basic header for personal mode', () => {
    const config = atlassian.config.apiKey!;
    const mode = config.authModes!.find(m => m.id === 'personal')!;
    const encoded = btoa('user@example.com:token123');
    const { url, init } = buildUpstreamRequest(encoded, config, mode);

    expect(url).toBe('https://mcp.atlassian.com/v1/mcp');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Basic ${encoded}`);
  });

  it('falls back to top-level inject when no mode provided', () => {
    const config = atlassian.config.apiKey!;
    const encoded = btoa('user@example.com:token123');
    const { init } = buildUpstreamRequest(encoded, config);

    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Basic ${encoded}`);
  });
});
