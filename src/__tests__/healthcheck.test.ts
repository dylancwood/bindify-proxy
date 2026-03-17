import { describe, it, expect } from 'vitest';
import { isHealthCheckRequest, healthCheckResponse } from '../proxy/healthcheck';

describe('Health Check', () => {
  it('detects POST with JSON-RPC method "ping" as health check', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 });
    const request = new Request('https://example.com/mcp/linear/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const result = await isHealthCheckRequest(request);
    expect(result.isHealth).toBe(true);
    expect(result.body).toBe(body);
  });

  it('does NOT detect POST with JSON-RPC method "initialize" as health check', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 42 });
    const request = new Request('https://example.com/mcp/linear/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const result = await isHealthCheckRequest(request);
    expect(result.isHealth).toBe(false);
    expect(result.body).toBe(body);
  });

  it('detects POST with JSON-RPC method "health" as health check', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'health', id: 5 });
    const request = new Request('https://example.com/mcp/linear/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const result = await isHealthCheckRequest(request);
    expect(result.isHealth).toBe(true);
  });

  it('does NOT detect GET request as health check', async () => {
    const request = new Request('https://example.com/mcp/linear/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/messages', {
      method: 'GET',
    });

    const result = await isHealthCheckRequest(request);
    expect(result.isHealth).toBe(false);
  });

  it('does NOT detect POST with non-health method as health check', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    const request = new Request('https://example.com/mcp/linear/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const result = await isHealthCheckRequest(request);
    expect(result.isHealth).toBe(false);
    expect(result.body).toBe(body);
  });

  it('does NOT detect POST with invalid JSON as health check', async () => {
    const request = new Request('https://example.com/mcp/linear/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/messages', {
      method: 'POST',
      body: 'not json',
    });

    const result = await isHealthCheckRequest(request);
    expect(result.isHealth).toBe(false);
  });

  it('healthCheckResponse returns proper JSON-RPC response', () => {
    const response = healthCheckResponse(42);
    expect(response.status).toBe(200);
  });

  it('healthCheckResponse defaults id to 1', async () => {
    const response = healthCheckResponse();
    const body = await response.json();
    expect(body).toEqual({
      jsonrpc: '2.0',
      result: { status: 'ok', version: 'dev' },
      id: 1,
    });
  });
});
