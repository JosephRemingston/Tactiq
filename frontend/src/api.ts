export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export interface ApiResult {
  status: number;
  ms: number;
  body: unknown;
  requestId: string | null;
}

export async function call(path: string, init: { method?: string; token?: string | null; body?: unknown } = {}): Promise<ApiResult> {
  const started = performance.now();
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    return { status: res.status, ms: Math.round(performance.now() - started), body, requestId: res.headers.get('x-request-id') };
  } catch (err) {
    return { status: 0, ms: Math.round(performance.now() - started), body: { error: (err as Error).message }, requestId: null };
  }
}
