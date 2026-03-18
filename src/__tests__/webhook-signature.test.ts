import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyWebhookSignature } from '../billing/stripe';

/** Helper: compute a valid Stripe-style HMAC-SHA256 signature header */
async function sign(payload: string, secret: string, timestampOverride?: number): Promise<{ header: string; timestamp: number }> {
  const timestamp = timestampOverride ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const hex = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { header: `t=${timestamp},v1=${hex}`, timestamp };
}

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test_secret_key';
  const payload = '{"type":"checkout.session.completed"}';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a valid signature (happy path)', async () => {
    const { header } = await sign(payload, secret);
    const result = await verifyWebhookSignature(payload, header, secret);
    expect(result).toBe(true);
  });

  it('rejects a wrong signature of correct length (constant-time comparison)', async () => {
    const { header } = await sign(payload, secret);
    // Flip a character in the v1= hex to produce a same-length but wrong sig
    const parts = header.split(',');
    const v1Part = parts.find(p => p.startsWith('v1='))!;
    const hex = v1Part.slice(3);
    const flipped = hex[0] === 'a' ? 'b' + hex.slice(1) : 'a' + hex.slice(1);
    const tamperedHeader = `${parts.find(p => p.startsWith('t='))},v1=${flipped}`;

    const result = await verifyWebhookSignature(payload, tamperedHeader, secret);
    expect(result).toBe(false);
  });

  it('rejects a wrong signature of incorrect length (padding logic)', async () => {
    const { header } = await sign(payload, secret);
    const tPart = header.split(',').find(p => p.startsWith('t='))!;
    // Use a shorter hex string
    const result = await verifyWebhookSignature(payload, `${tPart},v1=deadbeef`, secret);
    expect(result).toBe(false);
  });

  it('rejects an expired timestamp (>300s old)', async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400s ago
    const { header } = await sign(payload, secret, oldTimestamp);
    const result = await verifyWebhookSignature(payload, header, secret);
    expect(result).toBe(false);
  });

  it('accepts a timestamp within the 300s window', async () => {
    const recentTimestamp = Math.floor(Date.now() / 1000) - 200; // 200s ago
    const { header } = await sign(payload, secret, recentTimestamp);
    const result = await verifyWebhookSignature(payload, header, secret);
    expect(result).toBe(true);
  });

  it('rejects a malformed signature header (missing t=)', async () => {
    const result = await verifyWebhookSignature(payload, 'v1=abc123', secret);
    expect(result).toBe(false);
  });

  it('rejects a malformed signature header (missing v1=)', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const result = await verifyWebhookSignature(payload, `t=${ts}`, secret);
    expect(result).toBe(false);
  });

  it('rejects an empty signature header', async () => {
    const result = await verifyWebhookSignature(payload, '', secret);
    expect(result).toBe(false);
  });

  it('rejects when payload has been tampered with', async () => {
    const { header } = await sign(payload, secret);
    const result = await verifyWebhookSignature('{"type":"tampered"}', header, secret);
    expect(result).toBe(false);
  });

  it('rejects when signed with a different secret', async () => {
    const { header } = await sign(payload, 'wrong_secret');
    const result = await verifyWebhookSignature(payload, header, secret);
    expect(result).toBe(false);
  });

  it('rejects a longer-than-expected signature (padding handles overflow)', async () => {
    const { header } = await sign(payload, secret);
    const tPart = header.split(',').find(p => p.startsWith('t='))!;
    // Valid hex chars but longer than 64 chars (SHA-256 produces 64 hex chars)
    const longSig = 'ab'.repeat(40); // 80 hex chars
    const result = await verifyWebhookSignature(payload, `${tPart},v1=${longSig}`, secret);
    expect(result).toBe(false);
  });
});
