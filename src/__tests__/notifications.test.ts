import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendNewUserNotification } from '../notifications';
import type { Env } from '../index';

describe('sendNewUserNotification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const user = { id: 'user_1', email: 'test@example.com', created_at: '2026-03-15T00:00:00Z' };

  const env = { SMTP2GO_API_KEY: 'test-key', ADMIN_NOTIFICATION_EMAIL: 'admin@example.com', OPS_NOTIFICATION_ORIGIN_EMAIL: 'Ops <ops@example.com>' } as Env;

  it('sends email via SMTP2GO API when key is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await sendNewUserNotification(env, user);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.smtp2go.com/v3/email/send');
    expect(options?.method).toBe('POST');

    const body = JSON.parse(options?.body as string);
    expect(body.api_key).toBe('test-key');
    expect(body.to).toEqual(['admin@example.com']);
    expect(body.sender).toBe('Ops <ops@example.com>');
    expect(body.subject).toBe('New Bindify user signed up');
    expect(body.text_body).toContain('user_1');
    expect(body.text_body).toContain('test@example.com');
  });

  it('falls back to default sender when OPS_NOTIFICATION_ORIGIN_EMAIL is not set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const envWithoutOrigin = { SMTP2GO_API_KEY: 'test-key', ADMIN_NOTIFICATION_EMAIL: 'admin@example.com' } as Env;

    await sendNewUserNotification(envWithoutOrigin, user);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.sender).toBe('Bindify Notifications <notifications@bindify.dev>');
  });

  it('skips sending when SMTP2GO_API_KEY is not set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await sendNewUserNotification({} as Env, user);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips sending when ADMIN_NOTIFICATION_EMAIL is not set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await sendNewUserNotification({ SMTP2GO_API_KEY: 'test-key' } as Env, user);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not throw on API failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('error', { status: 500 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendNewUserNotification(env, user)).resolves.not.toThrow();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('handles null email gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    await sendNewUserNotification(env, { ...user, email: null });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1]?.body as string));
    expect(body.text_body).toContain('unknown');
  });
});
