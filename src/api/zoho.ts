import type { Env } from '../index';

interface ZohoTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface ZohoTicketResponse {
  id: string;
  ticketNumber: string;
}

export function isZohoConfigured(env: Env): boolean {
  return !!(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_REFRESH_TOKEN && env.ZOHO_ORG_ID && env.ZOHO_DEPARTMENT_ID);
}

export async function getZohoAccessToken(env: Env): Promise<string> {
  const cache = caches.default;
  const cacheKey = new Request('https://zoho-token-cache/access-token');
  const cached = await cache.match(cacheKey);
  if (cached) {
    const { access_token } = await cached.json() as { access_token: string };
    return access_token;
  }

  const accountsUrl = env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
  const params = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN!,
    client_id: env.ZOHO_CLIENT_ID!,
    client_secret: env.ZOHO_CLIENT_SECRET!,
    grant_type: 'refresh_token',
  });

  const response = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: 'POST',
    body: params,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Zoho token refresh failed: ${response.status} ${text}`);
  }

  const data = await response.json() as ZohoTokenResponse;

  await cache.put(
    cacheKey,
    new Response(JSON.stringify({ access_token: data.access_token }), {
      headers: { 'Cache-Control': 'max-age=3000' },
    })
  );

  return data.access_token;
}

export async function createZohoTicket(
  env: Env,
  accessToken: string,
  params: { email: string; subject: string; description: string; contactName?: string }
): Promise<ZohoTicketResponse> {
  const deskUrl = env.ZOHO_DESK_URL || 'https://desk.zoho.com';
  const body: Record<string, unknown> = {
    subject: params.subject,
    departmentId: env.ZOHO_DEPARTMENT_ID!,
    description: params.description,
    contact: {
      email: params.email,
      ...(params.contactName ? { lastName: params.contactName } : {}),
    },
    channel: 'Web',
  };

  const response = await fetch(`${deskUrl}/api/v1/tickets`, {
    method: 'POST',
    headers: {
      'Authorization': `Zoho-oauthtoken ${accessToken}`,
      'orgId': env.ZOHO_ORG_ID!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Zoho ticket creation failed: ${response.status} ${text}`);
  }

  return response.json() as Promise<ZohoTicketResponse>;
}

export async function uploadZohoAttachment(
  env: Env,
  accessToken: string,
  ticketId: string,
  file: File
): Promise<void> {
  const deskUrl = env.ZOHO_DESK_URL || 'https://desk.zoho.com';
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${deskUrl}/api/v1/tickets/${ticketId}/attachments`, {
    method: 'POST',
    headers: {
      'Authorization': `Zoho-oauthtoken ${accessToken}`,
      'orgId': env.ZOHO_ORG_ID!,
    },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Zoho attachment upload failed: ${response.status} ${text}`);
  }
}
