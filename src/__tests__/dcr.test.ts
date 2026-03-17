import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { getDCRClientId, getDCRRegistration, checkDCRRegistrationDirect } from '../services/dcr';
import type { DCRRegistration } from '../services/dcr';
import type { ServiceConfig } from '../services/types';

const notionConfig: ServiceConfig = {
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
};

const callbackUrl = 'https://api.bindify.dev/api/connections/callback';

describe('DCR Registration', () => {
  beforeEach(async () => {
    await env.KV.delete('dcr:notion');
    vi.restoreAllMocks();
  });

  it('registers and returns client_id on first call', async () => {
    const mockResponse = {
      client_id: 'dcr-client-123',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 201 })
    );

    const clientId = await getDCRClientId(notionConfig, env.KV, callbackUrl);
    expect(clientId).toBe('dcr-client-123');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://mcp.notion.com/register');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body.redirect_uris).toEqual([callbackUrl]);
    expect(body.client_name).toBe('Bindify');
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('returns cached client_id on subsequent calls', async () => {
    await env.KV.put('dcr:notion', JSON.stringify({ client_id: 'cached-id' }));

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const clientId = await getDCRClientId(notionConfig, env.KV, callbackUrl);
    expect(clientId).toBe('cached-id');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-registers when cache is empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ client_id: 'new-client-456' }), { status: 201 })
    );

    const clientId = await getDCRClientId(notionConfig, env.KV, callbackUrl);
    expect(clientId).toBe('new-client-456');
    expect(fetchSpy).toHaveBeenCalledOnce();

    const cached = await env.KV.get('dcr:notion');
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!);
    expect(parsed.client_id).toBe('new-client-456');
  });

  it('throws on registration failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Service unavailable', { status: 503 })
    );

    await expect(getDCRClientId(notionConfig, env.KV, callbackUrl))
      .rejects.toThrow('DCR registration failed');
  });
});

describe('getDCRRegistration', () => {
  beforeEach(async () => {
    await env.KV.delete('dcr:notion');
    vi.restoreAllMocks();
  });

  it('returns full registration object from cache', async () => {
    const cached = {
      client_id: 'cached-id',
      registration_client_uri: '/register/cached-id',
      registration_access_token: 'rat_abc',
    };
    await env.KV.put('dcr:notion', JSON.stringify(cached));
    const reg = await getDCRRegistration(notionConfig, env.KV, callbackUrl);
    expect(reg.client_id).toBe('cached-id');
    expect(reg.registration_client_uri).toBe('/register/cached-id');
    expect(reg.registration_access_token).toBe('rat_abc');
  });

  it('registers and returns full object on cache miss', async () => {
    const mockResponse = {
      client_id: 'new-client-789',
      registration_client_uri: '/register/new-client-789',
      registration_access_token: 'rat_xyz',
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 201 })
    );
    const reg = await getDCRRegistration(notionConfig, env.KV, callbackUrl);
    expect(reg.client_id).toBe('new-client-789');
    expect(reg.registration_client_uri).toBe('/register/new-client-789');
  });
});

describe('checkDCRRegistrationDirect', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns true when registration is alive (200)', async () => {
    const reg: DCRRegistration = { client_id: 'alive-client', registration_client_uri: 'https://mcp.notion.com/register/alive-client', registration_access_token: 'rat_token' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok', { status: 200 }));
    expect(await checkDCRRegistrationDirect(reg, notionConfig)).toBe(true);
  });

  it('sends registration_access_token as Bearer header', async () => {
    const reg: DCRRegistration = { client_id: 'client-with-token', registration_client_uri: 'https://mcp.notion.com/register/client-with-token', registration_access_token: 'rat_secret_123' };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await checkDCRRegistrationDirect(reg, notionConfig);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer rat_secret_123' }));
  });

  it('returns false when registration is dead (404)', async () => {
    const reg: DCRRegistration = { client_id: 'dead-client', registration_client_uri: 'https://mcp.notion.com/register/dead-client' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    expect(await checkDCRRegistrationDirect(reg, notionConfig)).toBe(false);
  });

  it('returns false when unauthorized (401)', async () => {
    const reg: DCRRegistration = { client_id: 'unauth-client', registration_client_uri: 'https://mcp.notion.com/register/unauth-client' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    expect(await checkDCRRegistrationDirect(reg, notionConfig)).toBe(false);
  });

  it('returns true on transient server error (5xx)', async () => {
    const reg: DCRRegistration = { client_id: 'error-client', registration_client_uri: 'https://mcp.notion.com/register/error-client' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Server error', { status: 500 }));
    expect(await checkDCRRegistrationDirect(reg, notionConfig)).toBe(true);
  });

  it('returns true on network error', async () => {
    const reg: DCRRegistration = { client_id: 'network-fail-client', registration_client_uri: 'https://mcp.notion.com/register/network-fail-client' };
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network timeout'));
    expect(await checkDCRRegistrationDirect(reg, notionConfig)).toBe(true);
  });

  it('returns true when no registration_client_uri (assume alive)', async () => {
    const reg: DCRRegistration = { client_id: 'no-uri-client' };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await checkDCRRegistrationDirect(reg, notionConfig)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves relative registration_client_uri against dcrRegistrationUrl', async () => {
    const reg: DCRRegistration = { client_id: 'relative-client', registration_client_uri: '/register/relative-client' };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await checkDCRRegistrationDirect(reg, notionConfig);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://mcp.notion.com/register/relative-client');
  });
});
