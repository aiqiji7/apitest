# APITest user proxy

`worker.js` is a standalone Cloudflare module Worker. It accepts the existing
`/proxy/<full target URL>` route, applies CLI identity headers, and forwards API
responses as streams. Deploy it in your own account and configure its HTTPS
origin in APITest's proxy field. The repository does not host a proxy service.

The proxy receives API keys, Authorization headers, request bodies, and target
query parameters. Use a proxy you control or trust. Header profiles are client
claims; they do not provide authenticated CLI identity.

## Deploy using the Cloudflare dashboard

1. Sign in to your own Cloudflare account and open **Workers & Pages**.
2. Select **Create application / Create Worker** and create a Worker (the initial
   Hello World template is sufficient). Choose a name such as
   `apitest-user-proxy`.
3. Open **Edit code**, replace the entry module's contents with all of
   [`worker.js`](./worker.js), and select **Deploy**. The file has no imports,
   dependencies, or account credentials. Keep the module's `export default`.
4. Copy the deployed HTTPS origin, for example
   `https://apitest-user-proxy.<your-subdomain>.workers.dev`.
5. Optionally add a plain text variable named `ALLOWED_ORIGINS` in the Worker's
   **Settings → Variables and Secrets**, then deploy the updated settings. Its
   value is a comma-separated list of exact page origins, for example
   `https://your-apitest.example,http://127.0.0.1:8080`. Do not include paths or
   trailing slashes.
6. In APITest, enter the Worker's origin in the proxy field and enable
   **经代理转发（HTTPS）**. Select a non-default CLI profile to request its UA
   override. The default profile still uses ordinary forwarding.

If Wrangler is already installed and authenticated, this optional command
deploys the same source; run it yourself when ready:

```bash
wrangler deploy --config proxy/wrangler.toml
```

No deployment was performed as part of the local verification. The minimal
Wrangler configuration contains no account IDs, keys, or other credentials.

## Frontend contract (also usable with an existing proxy)

The proxy base is an origin without `/proxy/`. Append `/proxy/` and the raw full
target URL, including its query. Do not decode the complete target first.

```js
const target = 'https://api.example/v1/chat/completions?variant=a%2Fb';
const proxy = 'https://your-proxy.example';
const profileHeaders = {
  'user-agent': 'codex_cli_rs/0.164.0 (Windows 10.0; x86_64)',
  originator: 'codex_cli_rs',
  'session-id': 'the-same-session-id-used-in-the-request',
  'thread-id': 'the-same-thread-id-used-in-the-request',
};
// Escape non-ASCII JSON characters for the outer HTTP header. The proxy still
// validates the decoded header values as HTTP ByteString values.
const overrides = JSON.stringify(profileHeaders).replace(/[\u007f-\uffff]/g,
  char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
const controller = new AbortController();
const response = await fetch(`${proxy}/proxy/${target}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer YOUR_API_KEY',
    'X-APITest-Override-Headers': overrides,
  },
  body: JSON.stringify({ model: 'your-model', messages: [], stream: true }),
  signal: controller.signal,
});
// Read response.body incrementally for SSE. controller.abort() cancels the request.
```

`X-APITest-Override-Headers` is optional. When present it must contain a JSON
object whose keys and values are strings. An empty object is valid; an empty
header, arrays, null, nested objects, and non-string values are invalid. Names
must be HTTP tokens. Values must fit ByteString and contain no control characters
other than horizontal tab (CR, LF, NUL and DEL are rejected). JSON escaping does
not make an otherwise invalid value acceptable.

Names are case insensitive and normalized to lower case. The last occurrence
after normalization wins. Allowed overrides are applied after incoming headers,
so custom UA, Authorization, API keys, identity IDs, and ordinary business fields
replace existing values. Generate identity IDs once per request and reuse them
in its body and override mapping.

The Worker removes all `x-apitest-*` control headers before forwarding. It also
strips Host, Content-Length, Origin, Referer, Cookie/Cookie2, `Sec-*`, `Proxy-*`,
`Access-Control-*`, browser-managed Accept-Charset/Accept-Encoding/Date/DNT/
Expect/Permissions-Policy, and hop headers Connection/Keep-Alive/TE/Trailer/
Transfer-Encoding/Upgrade. Fields named by the incoming Connection header are
removed as well. Trying to override any such field returns 400; the override
mapping cannot restore it. API credentials and business headers are retained.
The outbound runtime computes its own transport headers such as Host and framing.

Targets must use HTTP or HTTPS, have a hostname, and have no URL username or
password. Raw path/query escapes such as `%2F`, `%252F`, and `+` are preserved;
the outer query is appended to the pathname tail. For compatibility the whole
target may also be encoded once with `encodeURIComponent(target)`: only this
recognizable form is decoded once. URL fragments are not sent over HTTP.

Supported methods are GET, HEAD, POST, PUT, PATCH, DELETE, and OPTIONS. OPTIONS
is reserved for local preflight handling and never reaches the upstream. Other
methods return 405 with an Allow header. The request method, body stream, and
abort signal pass to fetch with `redirect: 'manual'`.

Responses use `new Response(upstream.body, ...)` for both JSON and SSE without
buffering. Ordinary upstream statuses, response bodies, and end-to-end headers
are retained. Hop headers, upstream CORS headers and Set-Cookie are removed;
the proxy supplies its own CORS policy. Statuses 301, 302, 303, 307 and 308 become
502 `UPSTREAM_REDIRECT`. The proxy does not follow the redirect or send Location
to the browser. Configure the final API URL directly.

## CORS and environment variables

`ALLOWED_ORIGINS` is the only optional environment variable. An absent or empty
value enables `Access-Control-Allow-Origin: *`. A nonempty comma-separated list
allows exact Origin matches, reflects the accepted origin, and adds `Vary:
Origin`. A request with a different Origin receives 403 without an allow-origin
header. Requests without Origin (including command-line clients) remain usable.
This is a browser origin policy, not authentication or an upstream access list.

Credentials mode is not enabled: there is no `Access-Control-Allow-Credentials`
header and browser cookies are stripped. Send API credentials explicitly in
Authorization or provider key headers, and use fetch's default credentials mode.

A valid preflight returns 204 and allows the supported methods. Allow-Headers
explicitly includes Authorization, Content-Type, Accept, `x-api-key`, `api-key`,
the control header, UA, all Codex/Claude identity fields and the eight
`x-stainless-*` profile fields. Valid requested business header names are added
from `Access-Control-Request-Headers`; reserved names are rejected. The preflight
cache time is 600 seconds, with Vary on the requested method and headers.

Actual responses expose `request-id`, `x-request-id`, `x-client-request-id`,
`retry-after`, and present `ratelimit-*`, `x-ratelimit-*`, and
`anthropic-ratelimit-*` headers. Locally generated errors use the same origin
policy and this stable shape, with no raw targets, query strings, keys, header
values, or runtime exception messages:

```json
{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"The proxy could not reach the upstream service."}}
```

| Status | Error code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_TARGET` | Invalid target URL or URL credentials |
| 400 | `INVALID_OVERRIDE_HEADERS` | Invalid or reserved override mapping |
| 400 | `INVALID_PREFLIGHT` | Invalid preflight method or requested headers |
| 403 | `ORIGIN_NOT_ALLOWED` | Origin does not match ALLOWED_ORIGINS |
| 404 | `NOT_FOUND` | Route is outside `/proxy/` |
| 405 | `METHOD_NOT_ALLOWED` | Unsupported method |
| 499 | `REQUEST_ABORTED` | Upstream fetch was cancelled before a response |
| 502 | `UPSTREAM_REDIRECT` | Upstream requested navigation |
| 502 | `UPSTREAM_UNAVAILABLE` | Upstream fetch could not complete |

After response headers have reached the client, a stream failure or cancellation
ends/errors that stream; it cannot replace the response with a JSON error. Abort
and stream cancellation propagate as supported by the hosting runtime.

## Local verification and browser development

Use Node 24 or newer. No package.json, dependency installation, real API keys,
external upstream calls, or Cloudflare account is needed for these commands:

```bash
node --check proxy/worker.js
node --check proxy/local.mjs
node --test proxy/*.test.mjs
```

The test command starts a real local mock HTTP upstream and the actual Worker
through `local.mjs` on ephemeral loopback ports, then closes both. It checks
header injection/removal, exact query escapes, methods, CORS, ordinary statuses,
safe errors, redirect destinations never being reached, and cancellation. For
SSE and chunked JSON, the upstream waits for an explicit test release after the
reader receives its first chunk, proving that delivery precedes upstream end.

Start the reusable proxy adapter for browser end-to-end tests:

```bash
node proxy/local.mjs --host 127.0.0.1 --port 8787
```

Serve APITest from a local HTTP origin such as `http://127.0.0.1:8080`, configure
the proxy as `http://127.0.0.1:8787`, and point the API URL at your local mock
upstream. For example, `http://127.0.0.1:9000/v1/models` reaches the adapter as
`http://127.0.0.1:8787/proxy/http://127.0.0.1:9000/v1/models`. The automated test
mock is scoped to the test run; use the browser harness's mock for interactive
API scenarios. An HTTPS hosted page should use the deployed HTTPS Worker;
loopback HTTP from an HTTPS page may be subject to browser mixed-content or
local-network restrictions.

Browser harnesses can import the adapter and supply the same environment:

```js
import { createProxyServer } from './proxy/local.mjs';
const server = createProxyServer({ env: { ALLOWED_ORIGINS: 'http://127.0.0.1:8080' } });
server.listen(8787, '127.0.0.1');
// Close the server and active connections when your harness finishes.
```

The adapter accepts `--host` and `--port` (including port 0), defaults to
127.0.0.1:8787, and reads ALLOWED_ORIGINS from the process environment. It is
testing infrastructure, not a production server. It bridges disconnects to an
AbortController and streams through Node's HTTP server; it also removes stale
compression/framing metadata when Node fetch has decoded a compressed body.

Node tests establish application behavior using native Request, Response, fetch,
and real local networking. They do **not** establish Cloudflare/workerd runtime
or deployed edge behavior. If Wrangler is already installed, use its local
runtime for an additional check:

```bash
wrangler dev --config proxy/wrangler.toml --local --ip 127.0.0.1 --port 8787
```

Validate the deployed HTTPS URL separately after deploying it yourself. Runtime
header handling, compression, platform limits, and cancellation may differ from
Node. The production entry remains the standalone `worker.js`; never deploy the
Node adapter as the Worker.
