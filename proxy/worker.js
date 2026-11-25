const CONTROL_HEADER = 'x-apitest-override-headers';
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const REQUEST_RESERVED = new Set([
  'host', 'content-length', 'origin', 'referer', 'cookie', 'cookie2',
  'accept-charset', 'accept-encoding', 'date', 'dnt', 'expect', 'permissions-policy',
]);
const DEFAULT_ALLOWED_HEADERS = [
  CONTROL_HEADER, 'authorization', 'content-type', 'accept', 'x-api-key', 'api-key',
  'user-agent', 'originator', 'session-id', 'thread-id', 'x-client-request-id',
  'x-codex-window-id', 'x-codex-turn-metadata', 'x-app', 'anthropic-version',
  'anthropic-beta', 'x-claude-code-session-id', 'x-stainless-lang',
  'x-stainless-package-version', 'x-stainless-os', 'x-stainless-arch',
  'x-stainless-runtime', 'x-stainless-runtime-version', 'x-stainless-retry-count',
  'x-stainless-timeout',
];
const DEFAULT_EXPOSED_HEADERS = ['request-id', 'x-request-id', 'x-client-request-id', 'retry-after'];

function connectionFields(headers) {
  return new Set((headers.get('connection') || '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean));
}

function isReserved(name, nominated) {
  return name.startsWith('x-apitest-') || name.startsWith('sec-') ||
    name.startsWith('proxy-') || name.startsWith('access-control-') ||
    REQUEST_RESERVED.has(name) || HOP_HEADERS.has(name) || nominated.has(name);
}

function corsHeaders(request, env) {
  const headers = new Headers();
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const origin = request.headers.get('origin');
  if (allowed.length) {
    headers.set('Vary', 'Origin');
    if (origin && allowed.includes(origin)) headers.set('Access-Control-Allow-Origin', origin);
  } else {
    headers.set('Access-Control-Allow-Origin', '*');
  }
  return { headers, denied: Boolean(allowed.length && origin && !allowed.includes(origin)) };
}

function fail(status, code, message, cors, extra = {}) {
  const headers = new Headers(cors);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}

function parseTarget(url) {
  let tail = url.pathname.slice('/proxy/'.length);
  // Only decode the optional whole-target encoding. Raw URLs retain their escapes.
  if (/^https?%3a%2f%2f/i.test(tail)) tail = decodeURIComponent(tail);
  const raw = tail + url.search;
  if (!/^https?:\/\//i.test(raw)) throw new TypeError('Invalid target');
  const target = new URL(raw);
  if (!['http:', 'https:'].includes(target.protocol) || !target.hostname || target.username || target.password) {
    throw new TypeError('Invalid target');
  }
  return target;
}

function outgoingHeaders(request) {
  const nominated = connectionFields(request.headers);
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!isReserved(name, nominated)) headers.set(name, value);
  }
  const serialized = request.headers.get(CONTROL_HEADER);
  if (serialized === null) return headers;
  const overrides = JSON.parse(serialized);
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Invalid override map');
  }
  for (const [key, value] of Object.entries(overrides)) {
    const name = key.toLowerCase();
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || !HEADER_VALUE.test(value) || isReserved(name, nominated)) {
      throw new TypeError('Invalid override field');
    }
    headers.set(name, value);
  }
  return headers;
}

function preflight(request, cors) {
  const method = request.headers.get('access-control-request-method');
  if (method && !METHODS.includes(method)) {
    return fail(400, 'INVALID_PREFLIGHT', 'The requested method is not supported.', cors);
  }
  const allowed = new Set(DEFAULT_ALLOWED_HEADERS);
  const nominated = connectionFields(request.headers);
  const requested = request.headers.get('access-control-request-headers');
  if (requested) {
    for (const field of requested.split(',')) {
      const name = field.trim().toLowerCase();
      if (!HEADER_NAME.test(name) || (name !== CONTROL_HEADER && isReserved(name, nominated))) {
        return fail(400, 'INVALID_PREFLIGHT', 'A requested header is not allowed.', cors);
      }
      allowed.add(name);
    }
  }
  const headers = new Headers(cors);
  headers.set('Access-Control-Allow-Methods', METHODS.join(', '));
  headers.set('Access-Control-Allow-Headers', [...allowed].join(', '));
  headers.set('Access-Control-Max-Age', '600');
  headers.append('Vary', 'Access-Control-Request-Method, Access-Control-Request-Headers');
  return new Response(null, { status: 204, headers });
}

function responseHeaders(upstream, cors) {
  const nominated = connectionFields(upstream.headers);
  const headers = new Headers();
  const exposed = new Set(DEFAULT_EXPOSED_HEADERS);
  for (const [name, value] of upstream.headers) {
    if (HOP_HEADERS.has(name) || nominated.has(name) || name.startsWith('access-control-') || name === 'set-cookie' || name === 'set-cookie2') continue;
    headers.set(name, value);
    if (/^(?:x-)?ratelimit-/.test(name) || /^anthropic-ratelimit-/.test(name) || /^(?:x-)?request-id$/.test(name)) exposed.add(name);
  }
  for (const [name, value] of cors) {
    if (name === 'vary' && headers.has('vary')) headers.append(name, value);
    else headers.set(name, value);
  }
  headers.set('Access-Control-Expose-Headers', [...exposed].join(', '));
  return headers;
}

export default {
  async fetch(request, env = {}, ctx) {
    const { headers: cors, denied } = corsHeaders(request, env);
    if (denied) return fail(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed.', cors);
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/proxy/')) {
      return fail(404, 'NOT_FOUND', 'Use the /proxy/<target URL> route.', cors);
    }
    if (!METHODS.includes(request.method)) {
      return fail(405, 'METHOD_NOT_ALLOWED', 'This method is not supported.', cors, { Allow: METHODS.join(', ') });
    }
    let target;
    try {
      target = parseTarget(url);
    } catch {
      return fail(400, 'INVALID_TARGET', 'Provide an HTTP or HTTPS target with a hostname and no URL credentials.', cors);
    }
    if (request.method === 'OPTIONS') return preflight(request, cors);
    let headers;
    try {
      headers = outgoingHeaders(request);
    } catch {
      return fail(400, 'INVALID_OVERRIDE_HEADERS', 'Override headers must be a JSON object of valid, allowed string header fields.', cors);
    }
    const options = {
      method: request.method,
      headers,
      signal: request.signal,
      redirect: 'manual',
    };
    if (!['GET', 'HEAD'].includes(request.method) && request.body) {
      options.body = request.body;
      // Native Node fetch requires this for streamed uploads; Workers use the same body directly.
      options.duplex = 'half';
    }
    let upstream;
    try {
      upstream = await fetch(target, options);
    } catch {
      if (request.signal.aborted) return fail(499, 'REQUEST_ABORTED', 'The request was cancelled.', cors);
      return fail(502, 'UPSTREAM_UNAVAILABLE', 'The proxy could not reach the upstream service.', cors);
    }
    if (REDIRECT_STATUSES.has(upstream.status)) {
      // Release the rejected response without reading or forwarding its contents.
      const cancelled = upstream.body?.cancel().catch(() => {});
      if (cancelled && ctx?.waitUntil) ctx.waitUntil(cancelled);
      return fail(502, 'UPSTREAM_REDIRECT', 'The upstream returned a redirect. Use its final API URL directly.', cors);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream, cors),
    });
  },
};
