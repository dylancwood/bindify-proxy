// src/crypto.ts
import { log } from './logger';

/** 10 years in seconds — used as expiry for tokens that don't expire */
export const PERMANENT_TOKEN_EXPIRY_SECONDS = 315_360_000;

export function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

export function base64UrlEncode(buffer: Uint8Array): string {
  let binary = "";
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const base64 = padded + "=".repeat(padLength);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function generateSecretBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function encodeCredentials(secret1: Uint8Array, secret2: Uint8Array): string {
  const combined = new Uint8Array(secret1.length + secret2.length);
  combined.set(secret1, 0);
  combined.set(secret2, secret1.length);
  return base64UrlEncode(combined);
}

export function decodeCredentials(credentials: string): {
  secret1Bytes: Uint8Array;
  secret2Bytes: Uint8Array;
  secret1Encoded: string;
  secret2Encoded: string;
} {
  const combined = base64UrlDecode(credentials);
  if (combined.length !== 64) {
    throw new Error(`Invalid credentials: expected 64 bytes, got ${combined.length}`);
  }
  const secret1Bytes = combined.slice(0, 32);
  const secret2Bytes = combined.slice(32, 64);
  return {
    secret1Bytes,
    secret2Bytes,
    secret1Encoded: base64UrlEncode(secret1Bytes),
    secret2Encoded: base64UrlEncode(secret2Bytes),
  };
}

export function encodeSecret1(secret1: Uint8Array): string {
  return base64UrlEncode(secret1);
}

// ─── Zero-knowledge token encryption (AES-256-GCM) ───

export async function deriveEncryptionKey(secret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('bindify-token-encryption'), info: new Uint8Array() },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptTokenData(data: string, secret2: string): Promise<string> {
  const key = await deriveEncryptionKey(secret2);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(data)
  );
  // Combine IV + ciphertext, base64 encode
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptTokenData(encrypted: string, secret2: string): Promise<string> {
  const key = await deriveEncryptionKey(secret2);
  const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(decrypted);
}

// ─── Managed token encryption (AES-256-GCM with HKDF from master key) ───

export async function deriveManagedEncryptionKey(masterKey: string, connectionId: string, extractable: boolean = false): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(masterKey),
    'HKDF',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(connectionId),
      info: new TextEncoder().encode('bindify-managed-token-encryption'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt']
  );
}

export async function encryptTokenDataWithKey(data: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(data)
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptTokenDataWithKey(encrypted: string, key: CryptoKey): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(decrypted);
}

// ─── Versioned key management ───

export async function computeKeyFingerprint(keyHex: string): Promise<string> {
  const data = new TextEncoder().encode(keyHex);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface ManagedKeyEntry {
  key: string;
  fingerprint: string; // computed via computeKeyFingerprint, not stored in config
}

export async function parseManagedKeys(json: string): Promise<ManagedKeyEntry[]> {
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error('MANAGED_ENCRYPTION_KEYS must be a JSON array');
  }
  if (parsed.length === 0) {
    throw new Error('MANAGED_ENCRYPTION_KEYS must contain at least one key');
  }

  const entries: ManagedKeyEntry[] = [];
  const seenFingerprints = new Set<string>();

  for (const entry of parsed) {
    if (typeof entry.key !== 'string' || entry.key.length === 0) {
      throw new Error('Key must be a non-empty string');
    }
    const fingerprint = await computeKeyFingerprint(entry.key);
    if (seenFingerprints.has(fingerprint)) {
      throw new Error(`Duplicate key fingerprint: ${fingerprint}`);
    }
    seenFingerprints.add(fingerprint);
    entries.push({ key: entry.key, fingerprint });
  }

  return entries;
}

export function getManagedKey(keys: ManagedKeyEntry[], fingerprint: string): string {
  const entry = keys.find((k) => k.fingerprint === fingerprint);
  if (!entry) {
    throw new Error(`No managed encryption key found for fingerprint ${fingerprint}`);
  }
  return entry.key;
}

export function getActiveKey(keys: ManagedKeyEntry[]): ManagedKeyEntry {
  return keys[keys.length - 1];
}

export function getManagedKeyWithFallback(keys: ManagedKeyEntry[], fingerprint: string, connectionId: string): string {
  if (fingerprint) {
    const entry = keys.find((k) => k.fingerprint === fingerprint);
    if (entry) return entry.key;
  }
  const active = getActiveKey(keys);
  log.warn('Managed key fingerprint not found, falling back to active key', {
    fingerprint,
    connectionId,
    activeFingerprint: active.fingerprint,
  });
  return active.key;
}
