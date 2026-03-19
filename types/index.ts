export interface User {
  id: string;
  stripe_customer_id: string | null;
  plan: 'free_trial' | 'active' | 'canceled';
  trial_ends_at: string | null;
  access_until: string | null;
  email: string | null;
  created_at: string;
}

export interface Connection {
  id: string;
  user_id: string;
  service: ServiceId;
  secret_url_segment_1: string;
  status: ConnectionStatus;
  key_storage_mode: 'managed' | 'zero_knowledge';
  auth_type: 'oauth' | 'api_key';
  auth_mode: string | null;
  application: string | null;
  label: string | null;
  dcr_registration: string | null;
  encrypted_tokens: string | null;
  key_version: number; // deprecated — kept because D1 still returns it; use key_fingerprint
  key_fingerprint: string;
  needs_reauth_at: string | null;
  suspended_at: string | null;
  last_used_at: string | null;
  last_refreshed_at: string | null;
  metadata: string | null;
  created_at: string;
}

export type ServiceId = 'linear' | 'todoist' | 'atlassian' | 'notion' | 'github' | 'figma';
export type ConnectionStatus = 'active' | 'error' | 'unused' | 'suspended';

export interface Subscription {
  id: string;
  user_id: string;
  quantity: number;
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  current_period_end: string;
  past_due_since: string | null;
  created_at: string;
}

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface ApiKeyData {
  api_key: string;
}

export interface ApiError {
  error: string;
  message: string;
}

export interface UserProfile {
  id: string;
  email: string;
  plan: User['plan'];
  max_connections: number;
  active_connections: number;
  trial_ends_at: string | null;
  access_until: string | null;
}
