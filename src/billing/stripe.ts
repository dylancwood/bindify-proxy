export async function stripeRequest(
  path: string,
  secretKey: string,
  options: { method?: string; body?: Record<string, string> } = {}
): Promise<Response> {
  const { method = 'GET', body } = options;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${secretKey}`,
  };
  let requestBody: string | undefined;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    requestBody = new URLSearchParams(body).toString();
  }
  return fetch(`https://api.stripe.com/v1${path}`, { method, headers, body: requestBody });
}

export async function verifyWebhookSignature(
  payload: string, signature: string, secret: string
): Promise<boolean> {
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const sig = parts.find(p => p.startsWith('v1='))?.slice(3);
  if (!timestamp || !sig) return false;
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
  if (age > 300) return false;
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  const encoder = new TextEncoder();
  const sigBytes = encoder.encode(sig);
  const expectedBytes = encoder.encode(expected);
  const maxLen = Math.max(sigBytes.length, expectedBytes.length);
  const paddedSig = new Uint8Array(maxLen);
  const paddedExpected = new Uint8Array(maxLen);
  paddedSig.set(sigBytes);
  paddedExpected.set(expectedBytes);
  const equal = crypto.subtle.timingSafeEqual(paddedSig, paddedExpected);
  return equal && sigBytes.length === expectedBytes.length;
}
