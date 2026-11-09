import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import type { ApiFailure, ApiSuccess, AuthResult, ErrorCode } from '@lumio/shared-types';

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: ErrorCode | 'NETWORK_ERROR',
    readonly details?: { path: string; issue: string }[],
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export const http = axios.create({ withCredentials: true, baseURL: '/api/v1' });

let accessToken: string | null = null;
export const setAccessToken = (token: string | null) => {
  accessToken = token;
};

let onSessionLost: () => void = () => undefined;
export const setSessionLostHandler = (handler: () => void) => {
  onSessionLost = handler;
};

/** Concurrent requests share one refresh, because refresh tokens are single use. */
let refreshing: Promise<AuthResult> | null = null;
export function refreshSession(): Promise<AuthResult> {
  refreshing ??= axios
    .post<ApiSuccess<AuthResult>>('/api/v1/auth/refresh', undefined, {
      withCredentials: true,
      headers: { 'X-Requested-With': 'lumio' },
    })
    .then((response) => {
      setAccessToken(response.data.data.accessToken);
      return response.data.data;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

http.interceptors.request.use((config) => {
  if (accessToken) config.headers.set('Authorization', `Bearer ${accessToken}`);
  config.headers.set('X-Requested-With', 'lumio');
  return config;
});

function toClientError(error: AxiosError<ApiFailure>): ApiClientError {
  const failure = error.response?.data?.error;
  if (failure) {
    return new ApiClientError(
      failure.message,
      error.response?.status,
      failure.code,
      failure.details,
    );
  }
  return new ApiClientError(
    'The server could not be reached.',
    error.response?.status,
    'NETWORK_ERROR',
  );
}

http.interceptors.response.use(undefined, async (error: AxiosError<ApiFailure>) => {
  const config = error.config as (InternalAxiosRequestConfig & { retried?: boolean }) | undefined;
  const isAuthRoute = config?.url?.startsWith('/auth/') && config.url !== '/auth/me';
  if (error.response?.status === 401 && config && !config.retried && !isAuthRoute) {
    config.retried = true;
    let refreshed = false;
    try {
      await refreshSession();
      refreshed = true;
    } catch {
      setAccessToken(null);
      onSessionLost();
    }
    if (refreshed) return http.request(config);
  }
  throw toClientError(error);
});

export interface Paged<T> {
  rows: T[];
  total: number;
}

export async function apiGet<T>(url: string, params?: object): Promise<T> {
  const response = await http.get<ApiSuccess<T>>(url, { params });
  return response.data.data;
}

export async function apiList<T>(url: string, params?: object): Promise<Paged<T>> {
  const response = await http.get<{ data: T[]; meta: { page?: { total: number } } }>(url, {
    params,
  });
  return {
    rows: response.data.data,
    total: response.data.meta.page?.total ?? response.data.data.length,
  };
}

export async function apiSend<T>(
  method: 'post' | 'patch' | 'put' | 'delete',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await http.request<ApiSuccess<T>>({
    method,
    url,
    data: body,
    headers: headers ?? {},
  });
  return response.data?.data;
}

/** Sends a command that moves money or stock, safe to retry with the same key. */
export function apiCommand<T>(url: string, body?: unknown, key = crypto.randomUUID()): Promise<T> {
  return apiSend<T>('post', url, body, { 'Idempotency-Key': key });
}

/** Health endpoints sit outside the versioned API and report failure with a 503 body. */
export async function fetchReadiness<T>(): Promise<T> {
  const response = await axios.get<ApiSuccess<T>>('/healthz/ready', {
    validateStatus: (status) => status === 200 || status === 503,
  });
  return response.data.data;
}

export async function downloadCsv(url: string, filename: string, params?: object): Promise<void> {
  const response = await http.get<Blob>(url, {
    params: { ...params, format: 'csv' },
    responseType: 'blob',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(response.data);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
