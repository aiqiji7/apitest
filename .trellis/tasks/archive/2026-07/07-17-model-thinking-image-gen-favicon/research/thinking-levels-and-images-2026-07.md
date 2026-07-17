# Research: Thinking levels + Images API (2026-07)

## Sources

- OpenAI Reasoning: https://developers.openai.com/api/docs/guides/reasoning
- OpenAI Latest model: https://developers.openai.com/api/docs/guides/latest-model
- LiteLLM PR #26456 (gpt-5.5 live 400s, 2026-04-24)
- Anthropic Adaptive thinking: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- Anthropic Effort: https://platform.claude.com/docs/en/build-with-claude/effort.md
- Gemini thinking: https://ai.google.dev/gemini-api/docs/thinking
- DeepSeek thinking mode: https://api-docs.deepseek.com/guides/thinking_mode/
- xAI Reasoning: https://docs.x.ai/developers/model-capabilities/text/reasoning
- OpenAI Images: https://developers.openai.com/api/docs/guides/image-generation
- OpenAI Image edit: https://developers.openai.com/api/reference/resources/images/methods/edit/

Search tools: WebSearch (Exa). groksearch-cli timed out; later Exa queries rate-limited for Mistral/Qwen/etc.

## OpenAI MODEL_CATALOG recommendations

| Pattern priority | levels | def | notes |
|------------------|--------|-----|-------|
| gpt-5.5-pro | medium, high, xhigh | medium | no none/minimal/low |
| gpt-5.5 | none, low, medium, high, xhigh | medium | **remove minimal** |
| gpt-5.6-pro (if any) | TBD | — | pro mode may be reasoning.mode not slug |
| gpt-5.6 | none, low, medium, high, xhigh, max | medium | new max |
| gpt-5.4 | none, low, medium, high, xhigh | medium | keep |
| gpt-5.2-pro | medium, high, xhigh | medium | keep |
| gpt-5.2 | none, low, medium, high, xhigh | medium | minDate keep |
| gpt-5.1-codex-max | low, medium, high, xhigh | medium | keep |
| gpt-5.1 | none, low, medium, high | none | keep |
| gpt-5-pro | high | high | keep |
| gpt-5 | minimal, low, medium, high | medium | keep |
| o[134] | low, medium, high | medium | keep |
| gpt- generic | minimal, low, medium, high | medium | keep |

## Anthropic

Current code:

- `claude-3` → budget_tokens low/medium/high/xhigh/max
- `claude-` → adaptive + output_config.effort low/medium/high/xhigh/max

Docs 2026:

- Adaptive models: effort low/medium/high/xhigh/max (xhigh on subset)
- Older: budget_tokens still needed

**Recommendation**: Keep structure; ensure adaptive levels include max; optional split for models that reject xhigh is low priority (generic list OK for test tool).

## Gemini

Current:

- `gemini-3` → thinking_level minimal/low/medium/high, noToggle
- `gemini-` → thinking_budget low/medium/high mapped to tokens

Docs:

- Gemini 3 Pro: no minimal
- Gemini 3 Flash: full four levels

**Recommendation**: Add `gemini-3.*pro` without minimal before generic `gemini-3`; keep 2.5 budget path.

## DeepSeek

Current: none/high/max + deepseek_reasoning — **aligned**.

## Grok

Current: all grok- → none/low/medium/high def low

Docs:

- grok-4.5: low/medium/high, default high, cannot disable
- older/4.3: none/low/medium/high

**Recommendation**:

```
{ pattern: /grok-4\.5/i, levels: ['low','medium','high'], def: 'high', param: 'reasoning_effort' }
{ pattern: /grok-/i, levels: ['none','low','medium','high'], def: 'low', param: 'reasoning_effort' }
```

## Other vendors

Mistral/Qwen/GLM/Kimi/Cohere/Nova: no fresh fetch due to rate limit. **Default: keep unless implement-time docs conflict.**

## Images API contracts (OpenAI-compatible)

### Text-to-image

```
POST {base}/v1/images/generations
Authorization: Bearer {key}
Content-Type: application/json

{
  "model": "{model}",
  "prompt": "{userText}",
  "n": 1,
  "size": "1024x1024"
}
```

Optional: `quality`, `response_format` (dall-e), `output_format` (gpt-image).

Response: `{ data: [ { b64_json?: string, url?: string } ] }`

### Image-to-image / edit

```
POST {base}/v1/images/edits
Authorization: Bearer {key}
```

Preferred for browser pure-frontend with data URL:

- Multipart: `image` file + `prompt` + `model`
- Or JSON (newer GPT image): `images: [{ image_url: "data:..." }]` + `prompt` + `model`

**Implementation preference**:

1. Try JSON body with `image` / `images` + data URL when `currentImageData` is data URL or http URL (many compatible gateways accept this).
2. If needed, convert data URL → Blob → FormData multipart as fallback path.

MVP: JSON-first with `image` as data URL string OR multipart FormData from data URL blob — pick one path that works with official OpenAI and document gateway variance.

### Endpoint helpers

Mirror existing:

```js
function buildImagesGenerationsEndpoint(base) {
  return stripTrailingSlash(applyProxy(base)) + '/v1/images/generations';
}
function buildImagesEditsEndpoint(base) {
  return stripTrailingSlash(applyProxy(base)) + '/v1/images/edits';
}
```

## Model dropdown selected state

Current `renderModelDropdown` does not mark selected item.

```js
const current = (modelEl.value || '').trim();
const selectedClass = id === current ? ' selected' : '';
// class="model-dropdown-item selected"
```

CSS:

```css
.model-dropdown-item.selected {
  background: #dbeafe; /* or #e0f2fe */
  color: #1e40af;
}
.model-dropdown-item.selected:hover {
  background: #bfdbfe;
}
```

## Favicon

- New `assets/favicon.svg` — simple "API" monogram or geometric mark in `#1e90ff`
- `index.html`: `<link rel="icon" href="assets/favicon.svg" type="image/svg+xml" />`
