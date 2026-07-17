# Design: model thinking + Images tab + favicon + model highlight

## Architecture

Single-page pure frontend. All changes stay in:

| File | Role |
|------|------|
| `assets/js/script.js` | MODEL_CATALOG, vendor tests, Images scenarios, model dropdown |
| `index.html` | Images vendor button, favicon link |
| `assets/css/styles.css` | selected model item, optional Images UI polish |
| `assets/favicon.svg` | new favicon |

No backend, no new dependencies.

## Boundaries

### Vendor model

```
currentVendor ∈ { openai, anthropic, google, images }
```

- `openai` / `anthropic` / `google`: existing chat/vision/tool tests
- `images`: only image generation/edit scenarios; no protocol switch

### Protocol switch

```
openaiProtocolWrap.display = (vendor === 'openai') ? '' : 'none'
```

Images does not use `openaiProtocol`.

### Scenario IDs

| Scenario | Vendor | Endpoint |
|----------|--------|----------|
| openai_image (rename label only) | openai | chat/responses vision |
| anthropic_image | anthropic | messages vision |
| gemini_image | google | generateContent vision |
| images_generate | images | `/v1/images/generations` |
| images_edit | images | `/v1/images/edits` |

`IMAGE_SCENARIOS` expands to include `images_edit` (requires input image).  
`images_generate` is **not** in IMAGE_SCENARIOS (no required input image).

Optional: `IMAGE_GEN_SCENARIOS` for result rendering helpers.

## Data flow — Images generate

```
user click 文生图
  → applyScenarioInput: hide image area (or leave hidden)
  → user edits prompt
  → send:
       POST buildImagesGenerationsEndpoint(apiUrl)
       body: { model, prompt: userText, n: 1, size: "1024x1024" }
  → parse data[0].b64_json | data[0].url
  → addMessage / inline img + addBlock response
```

## Data flow — Images edit

```
user click 图生图
  → show image area, load default test image if empty
  → send:
       POST buildImagesEditsEndpoint(apiUrl)
       body: multipart or JSON with image + prompt + model
  → same result rendering as generate
```

### Edit request body strategy

**Primary (JSON, OpenAI-compatible modern)**:

```json
{
  "model": "...",
  "prompt": "...",
  "image": ["data:image/png;base64,..."]
}
```

or `images: [{ "image_url": "data:..." }]` depending on gateway.

**Chosen MVP**: FormData multipart with fields `model`, `prompt`, `image` (Blob from data URL). Widest compatibility with classic OpenAI `/images/edits` and many proxies. If `currentImageData` is remote URL, fetch→blob when same-origin/CORS allows; else alert user to upload file.

Actually for pure frontend CORS: remote image URL may fail. Prefer:

1. data URL → Blob → FormData (always works for local upload / default embedded image)
2. if only remote URL: try JSON `image_url` field; on failure show clear error

## Thinking catalog changes

Update `MODEL_CATALOG` array only + any param builders if new levels need mapping (e.g. `max` already works for reasoning_effort string pass-through).

`buildThinkingParams` for `reasoning_effort` already returns `{ reasoning_effort: level }` — `max` needs no new case.

## Model selected highlight

In `renderModelDropdown`:

- Compare `m.id || m.name` with `modelEl.value.trim()`
- Add class `selected` when equal
- CSS background distinct from hover

No new state variable required.

## Favicon

Static SVG asset + link tag. Cache-bust optional (`?v=20260717`).

## Compatibility / Rollback

- Scenario renames are label-only → low risk
- New vendor is additive
- Catalog changes may hide illegal levels → reduces 400s
- Rollback: revert the four files + delete favicon.svg

## Trade-offs

| Decision | Choice | Why |
|----------|--------|-----|
| Images as 4th vendor | Yes | User request; separates gen from vision |
| multipart for edits | Prefer FormData | Classic OpenAI edits contract |
| Full vendor catalog audit | Evidence-based only | Avoid speculative breaks |
| Selected highlight exact string match | Yes | Simple; no fuzzy match |
