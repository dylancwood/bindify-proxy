import type { User } from '@bindify/types';
import { getUserById, createUser, updateUserEmail } from '../db/queries';

export class MaxUsersReachedError extends Error {
  constructor() {
    super('Maximum number of users reached');
    this.name = 'MaxUsersReachedError';
  }
}

/**
 * Ensures a user record exists in the database for the given Clerk user ID.
 * If the user does not exist, creates one with a free_trial plan and a
 * 7-day trial period.
 *
 * @param options.maxUsers - Optional cap on total users. If defined and the cap is
 *   reached, throws MaxUsersReachedError for new users. Existing users are
 *   always returned regardless of the cap.
 * @param options.email - Optional email from the Clerk JWT. Stored on create and
 *   updated if it has changed for an existing user.
 */
export async function ensureUser(
  db: D1Database,
  clerkUserId: string,
  options?: { maxUsers?: number; email?: string }
): Promise<{ user: User; isNew: boolean }> {
  const existing = await getUserById(db, clerkUserId);
  if (existing) {
    if (options?.email && existing.email !== options.email) {
      await updateUserEmail(db, clerkUserId, options.email);
    }
    return { user: { ...existing, email: options?.email ?? existing.email }, isNew: false };
  }

  const maxUsers = options?.maxUsers;
  if (maxUsers !== undefined) {
    const result = await db.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>();
    if (result && result.count >= maxUsers) {
      throw new MaxUsersReachedError();
    }
  }

  const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await createUser(db, clerkUserId, trialEndsAt, options?.email);

  const user = await getUserById(db, clerkUserId);
  if (!user) throw new Error('Failed to create user');
  return { user, isNew: true };
}
