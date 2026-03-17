import type { Env } from '../index';
import { isZohoConfigured, getZohoAccessToken, createZohoTicket, uploadZohoAttachment } from './zoho';
import { log } from '../logger';

declare const BUILD_VERSION: string;
const VERSION = typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : 'dev';

const NONCE_TTL_SECONDS = 300;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export async function handleGenerateNonce(env: Env): Promise<Response> {
  const nonce = crypto.randomUUID();
  await env.KV.put(`support-nonce:${nonce}`, '1', { expirationTtl: NONCE_TTL_SECONDS });
  return Response.json({ nonce });
}

async function consumeNonce(env: Env, nonce: string): Promise<boolean> {
  const key = `support-nonce:${nonce}`;
  const value = await env.KV.get(key);
  if (!value) return false;
  await env.KV.delete(key);
  return true;
}

export async function handleSupportTicket(request: Request, env: Env): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json(
      { error: 'invalid_request', message: 'Expected multipart/form-data' },
      { status: 400 }
    );
  }

  const nonce = formData.get('nonce') as string | null;
  const email = formData.get('email') as string | null;
  const username = formData.get('username') as string | null;
  const topic = formData.get('topic') as string | null;
  const description = formData.get('description') as string | null;
  const file = formData.get('file') as File | null;

  // Validate fields first so users get specific error messages
  if (!nonce) {
    return Response.json(
      { error: 'invalid_request', message: 'nonce is required' },
      { status: 400 }
    );
  }

  // Consume nonce immediately to prevent replay attacks with varied field values
  const nonceValid = await consumeNonce(env, nonce);
  if (!nonceValid) {
    return Response.json(
      { error: 'invalid_nonce', message: 'Invalid or expired nonce. Please reload and try again.' },
      { status: 403 }
    );
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json(
      { error: 'invalid_request', message: 'A valid email is required' },
      { status: 400 }
    );
  }

  if (!topic || topic.trim().length === 0) {
    return Response.json(
      { error: 'invalid_request', message: 'Support topic is required' },
      { status: 400 }
    );
  }

  if (!description || description.trim().length === 0) {
    return Response.json(
      { error: 'invalid_request', message: 'Description is required' },
      { status: 400 }
    );
  }

  if (file && file.size > MAX_FILE_SIZE) {
    return Response.json(
      { error: 'invalid_request', message: 'File must be under 10MB' },
      { status: 400 }
    );
  }

  // Check Zoho config after validation so users get field errors first
  if (!isZohoConfigured(env)) {
    return Response.json(
      { error: 'service_unavailable', message: 'Support ticket system is not configured' },
      { status: 503 }
    );
  }

  try {
    const accessToken = await getZohoAccessToken(env);
    const descriptionWithVersion = `${description.trim()}\n\n---\nApp version: ${VERSION}`;
    const ticket = await createZohoTicket(env, accessToken, {
      email,
      subject: topic.trim(),
      description: descriptionWithVersion,
      contactName: username?.trim() || undefined,
    });

    if (file && file.size > 0) {
      try {
        await uploadZohoAttachment(env, accessToken, ticket.id, file);
      } catch (err) {
        log.error('Failed to upload attachment to Zoho', err, { ticketId: ticket.id });
      }
    }

    return Response.json({ ok: true, ticketNumber: ticket.ticketNumber });
  } catch (err) {
    log.error('Failed to create Zoho ticket', err);
    return Response.json(
      { error: 'ticket_creation_failed', message: 'Failed to create support ticket. Please try again or email support@bindify.dev.' },
      { status: 500 }
    );
  }
}
