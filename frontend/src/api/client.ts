/**
 * client.ts — thin typed fetch wrapper. This is the frontend's equivalent of
 * store.py: every server call goes through here, same-origin, credentials
 * included, JSON in/out, 401 -> redirect to /login.
 */

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/** Same-origin base — the built app is served from the same host as the API. */
const BASE = '';

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const hasBody = opts.body !== undefined;

  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (res.status === 401) {
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new ApiError(401, 'Unauthorized');
  }

  if (!res.ok) {
    let message = res.statusText || `Request failed with status ${res.status}`;
    try {
      const data: unknown = await res.clone().json();
      if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
        message = data.error;
      }
    } catch {
      // response body wasn't JSON — fall back to statusText
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { method: 'GET', signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'POST', body, signal }),
  put: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'PUT', body, signal }),
  patch: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'PATCH', body, signal }),
  delete: <T>(path: string, signal?: AbortSignal) =>
    request<T>(path, { method: 'DELETE', signal }),
};
