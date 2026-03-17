import { generateSecretBytes, encodeCredentials, encodeSecret1, base64UrlEncode } from '../crypto';

export function makeTestCredentials() {
  const secret1Bytes = generateSecretBytes(32);
  const secret2Bytes = generateSecretBytes(32);
  const credentials = encodeCredentials(secret1Bytes, secret2Bytes);
  const secret1 = encodeSecret1(secret1Bytes);
  const secret2 = base64UrlEncode(secret2Bytes);
  return { credentials, secret1, secret2, secret1Bytes, secret2Bytes };
}

export function makeFixedCredentials(secret1Fill: number, secret2Fill: number) {
  const secret1Bytes = new Uint8Array(32).fill(secret1Fill);
  const secret2Bytes = new Uint8Array(32).fill(secret2Fill);
  const credentials = encodeCredentials(secret1Bytes, secret2Bytes);
  const secret1 = encodeSecret1(secret1Bytes);
  const secret2 = base64UrlEncode(secret2Bytes);
  return { credentials, secret1, secret2, secret1Bytes, secret2Bytes };
}

export function makeTestApiKey(credentials: string): string {
  return `bnd_test_${credentials}`;
}
