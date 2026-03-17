import type { ServiceId, TokenData } from '@bindify/types';

export interface ApiKeyInjectHeader {
  type: 'header';
  name: string;
  prefix?: string;
}

export interface ApiKeyInjectQuery {
  type: 'query';
  name: string;
}

export interface ApiKeyValidation {
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
  expectStatus: number;
}

export interface ApiKeyField {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'password';
}

export interface ApiKeyAuthMode {
  id: string;
  label: string;
  instructions?: string;
  fields?: ApiKeyField[];
  assembleApiKey?: (fields: Record<string, string>) => string;
  inject: ApiKeyInjectHeader | ApiKeyInjectQuery;
  proxyInject?: ApiKeyInjectHeader | ApiKeyInjectQuery;
}

export interface ApplicationOption {
  id: string;
  label: string;
  toolPattern: string;
}

export interface ApiKeyConfig {
  inject: ApiKeyInjectHeader | ApiKeyInjectQuery;
  proxyInject?: ApiKeyInjectHeader | ApiKeyInjectQuery;
  validate: ApiKeyValidation;
  instructions: string;
  fields?: ApiKeyField[];
  assembleApiKey?: (fields: Record<string, string>) => string;
  authModes?: ApiKeyAuthMode[];
  applications?: ApplicationOption[];
}

export interface ServiceConfig {
  id: ServiceId;
  name: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  clientIdEnvKey?: string;
  clientSecretEnvKey?: string;
  mcpBaseUrl: string;
  transport: 'sse' | 'streamable-http';
  usePKCE?: boolean;
  useDCR?: boolean;
  dcrRegistrationUrl?: string;
  healthCheckPattern?: RegExp;
  apiKey?: ApiKeyConfig;
  requiresRefresh?: boolean;
}

export interface ServiceOverrides {
  parseTokenResponse?: (raw: any) => TokenData;
  shouldRefresh?: (token: TokenData) => boolean;
  buildAuthUrl?: (config: ServiceConfig, params: Record<string, string>) => string;
}

export interface ServiceDefinition {
  config: ServiceConfig;
  overrides?: ServiceOverrides;
}
