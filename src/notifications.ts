import type { Env } from './index';

export async function sendNewUserNotification(
  env: Env,
  user: { id: string; email: string | null; created_at: string }
): Promise<void> {
  if (!env.SMTP2GO_API_KEY) {
    console.warn('SMTP2GO_API_KEY not configured — skipping new user notification');
    return;
  }

  if (!env.ADMIN_NOTIFICATION_EMAIL) {
    console.warn('ADMIN_NOTIFICATION_EMAIL not configured — skipping new user notification');
    return;
  }

  const envPrefix = env.SECRET_ENV_PREFIX === 'live' ? '' : `[${(env.SECRET_ENV_PREFIX || 'dev').toUpperCase()}] `;
  const res = await fetch('https://api.smtp2go.com/v3/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.SMTP2GO_API_KEY,
      to: [env.ADMIN_NOTIFICATION_EMAIL],
      sender: env.OPS_NOTIFICATION_ORIGIN_EMAIL ?? 'Bindify Notifications <notifications@bindify.dev>',
      subject: `${envPrefix}New Bindify user signed up`,
      text_body: [
        'New user registered on Bindify.',
        '',
        `ID:      ${user.id}`,
        `Email:   ${user.email ?? 'unknown'}`,
        `Time:    ${user.created_at}`,
      ].join('\n'),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`SMTP2GO notification failed: ${res.status} ${body}`);
  }
}
