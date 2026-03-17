import { describe, it, expect } from 'vitest';
import { jsonRpcError, extractRequestId } from '../proxy/errors';

describe('jsonRpcError', () => {
  it('returns JSON-RPC 2.0 error with given id, code, message, and HTTP status', async () => {
    const res = jsonRpcError(42, -32001, 'Connection not found', 404);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 42,
      error: { code: -32001, message: 'Connection not found' },
    });
  });

  it('handles null id', async () => {
    const res = jsonRpcError(null, -32600, 'Invalid request', 400);
    const body = await res.json() as any;
    expect(body.id).toBeNull();
  });

  it('handles string id', async () => {
    const res = jsonRpcError('abc-123', -32001, 'Not found', 404);
    const body = await res.json() as any;
    expect(body.id).toBe('abc-123');
  });
});

describe('extractRequestId', () => {
  it('extracts numeric id from valid JSON-RPC body', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 7 });
    expect(extractRequestId(body)).toBe(7);
  });

  it('extracts string id from valid JSON-RPC body', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 'req-1' });
    expect(extractRequestId(body)).toBe('req-1');
  });

  it('returns null for missing id', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(extractRequestId(body)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(extractRequestId('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractRequestId('')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(extractRequestId(undefined)).toBeNull();
  });
});
