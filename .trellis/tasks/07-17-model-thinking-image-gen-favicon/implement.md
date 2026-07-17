# Implement checklist

## Pre-flight

- [ ] User approved planning artifacts
- [ ] `task.py start` after approval
- [ ] Load `trellis-before-dev` for frontend specs

## 1. Research residual (if needed)

- [ ] Quick confirm Mistral/Qwen/GLM only if touching those patterns
- [ ] Default: leave untouched without conflict

## 2. MODEL_CATALOG update (`script.js`)

- [ ] Fix gpt-5.5: remove `minimal`
- [ ] Add/fix gpt-5.5-pro: medium/high/xhigh
- [ ] Add gpt-5.6: none/low/medium/high/xhigh/max
- [ ] Grok-4.5 specific entry before generic grok-
- [ ] Gemini-3 pro without minimal (optional specific pattern)
- [ ] Anthropic: verify max present on adaptive
- [ ] DeepSeek: leave if aligned
- [ ] Sync notes in `.trellis/spec/frontend/component-guidelines.md` catalog examples if they show gpt-5.5 wrong

## 3. Rename 图片支持 → 图片识别

- [ ] `getOpenaiTests` imageLabel
- [ ] `vendorTests.anthropic` / `google` labels
- [ ] Optional success strings: 「图片已成功被模型识别并处理」 already OK

## 4. Images vendor Tab

### HTML

- [ ] `#vendorType` add button `data-vendor="images"` 文案 `Images`

### JS config

- [ ] `vendorTests.images = [ { images_generate }, { images_edit } ]`
- [ ] `renderTestButtons`: support images vendor (static list)
- [ ] `setActiveVendor`: hide protocol for non-openai (already)
- [ ] `buildImagesGenerationsEndpoint` / `buildImagesEditsEndpoint`
- [ ] Expand `IMAGE_SCENARIOS` with `images_edit` only
- [ ] Default prompts: 文生图「一只在草地上奔跑的柯基」；图生图「把这张图改成水彩风格」

### Request handlers

- [ ] Branch `scenario === 'images_generate'`
- [ ] Branch `scenario === 'images_edit'`
- [ ] Helper `renderGeneratedImages(responseJson)` for b64/url
- [ ] Non-stream JSON fetch (Images API typically non-SSE for MVP)
- [ ] Respect proxy via `applyProxy` / existing endpoint builders
- [ ] Thinking toggle: **do not** attach thinking params to Images API

## 5. Model dropdown selected highlight

- [ ] `renderModelDropdown`: add `selected` class when id matches `modelEl.value`
- [ ] CSS `.model-dropdown-item.selected`
- [ ] Ensure filter path also calls same renderer

## 6. Favicon

- [ ] Create `assets/favicon.svg` (simple blue mark)
- [ ] `index.html` `<link rel="icon" ...>`

## 7. Validation

- [ ] Manual: switch vendors, protocol still only on OpenAI
- [ ] Manual: model list selected background
- [ ] Manual: catalog levels for gpt-5.5 / 5.5-pro / 5.6 / grok-4.5
- [ ] Manual: 图片识别 label on 3 vendors
- [ ] Manual: Images generate/edit request shape in 请求块
- [ ] `git status` / visual smoke only (no automated test suite)

## Rollback points

1. After catalog-only change
2. After rename-only
3. After Images tab
4. After favicon + highlight

## Risky files

- `assets/js/script.js` (large; careful scenario switch)
- `index.html` vendor buttons
