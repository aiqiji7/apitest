# Proxy runtime evidence

Research on 2026-11-25 used groksearch-cli extraction/search and official documentation/source inspection. These references refine the existing scope, without adding a hosted service or dependencies.

- WHATWG Fetch no longer lists User-Agent as a forbidden request header: https://fetch.spec.whatwg.org/#forbidden-request-header
- MDN documents Chromium silently ignoring a scripted User-Agent: https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header
- Chromium current source retains the restriction; a historical implementation change alone is not evidence of released behavior: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/http/http_util.cc
- Cloudflare CORS proxy example: https://developers.cloudflare.com/workers/examples/cors-header-proxy/
- Cloudflare official example source: https://github.com/cloudflare/cloudflare-docs/blob/c053ec26d74ab2d67e4d013c018a8b5201e3a062/src/content/docs/workers/examples/cors-header-proxy.mdx
- Direct Response.body forwarding preserves streaming without buffering: https://developers.cloudflare.com/workers/runtime-apis/streams/
- Request redirect=follow may forward credentials across domains; use manual and convert redirects to readable errors: https://developers.cloudflare.com/workers/runtime-apis/request/
- Browser manual redirects yield opaque responses: https://developer.mozilla.org/en-US/docs/Web/API/Response/type#opaqueredirect
- Connection headers also nominate fields that intermediaries must remove: https://www.rfc-editor.org/rfc/rfc9110.html#section-7.6.1
- Authorization must be explicitly permitted by CORS preflight: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Allow-Headers
- Wrangler local development uses workerd: https://developers.cloudflare.com/workers/local-development/

Contract conclusions: keep existing raw /proxy/<full-url> shape, preserve query and existing percent encodings, validate target schemes and header maps, strip internal/browser/hop headers, preserve ordinary upstream statuses and bodies, do not follow or expose redirects to the browser. Node native Request/Response real-network tests establish application behavior but do not establish Cloudflare runtime deployment behavior.
