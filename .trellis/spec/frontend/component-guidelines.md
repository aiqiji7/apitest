# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

(To be filled by the team)

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

<!-- How styles are applied (CSS modules, styled-components, Tailwind, etc.) -->

(To be filled by the team)

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

### Common Mistake: Adding event handlers to dynamically created elements

**Symptom**: Click handlers added to dropdown items don't fire, or fire inconsistently. Memory leak from accumulating event handlers on each UI update.

**Cause**: When dropdown items are recreated on each input event (e.g., `updateThinkingUI()` called on every keystroke), adding click handlers to each item creates:
1. Stale handlers on removed elements (memory leak)
2. Race condition where document-level "close on outside click" fires before item handler

**Fix**: Use **event delegation** on the parent container:

```js
// Don't: add handlers to each item on every update
function updateThinkingUI() {
  effortDropdown.innerHTML = '';
  levels.forEach(level => {
    const item = document.createElement('div');
    item.addEventListener('click', () => selectLevel(level)); // Leaks!
    effortDropdown.appendChild(item);
  });
}

// Do: delegate from parent, bind once
effortDropdown.addEventListener('click', (e) => {
  const item = e.target.closest('[data-value]');
  if (!item) return;
  e.stopPropagation(); // Prevent document handler from closing dropdown
  selectLevel(item.dataset.value);
});
```

**Prevention**: For any UI that rebuilds child elements dynamically, bind event handlers to the parent container once using event delegation.

---

### Common Mistake: Regex patterns that require trailing delimiters

**Symptom**: Model names like `o3`, `o4`, or `openrouter/o3-mini` don't match expected patterns.

**Cause**: Regex patterns like `/o1-|o3-|o4-/i` require a trailing hyphen, failing on:
- Standalone names: `o3`, `o4`
- Third-party prefixes without hyphen: `openrouter/o3-mini`

**Fix**: Use word boundary or non-alphanumeric lookahead:

```js
// Don't: require trailing hyphen
const pattern = /o1-|o3-|o4-/i;

// Do: match word boundary or end of string
const pattern = /\bo[134](?:[^a-z0-9]|$)/i;
```

**Test cases**:
- ✅ Match: `o3-mini`, `o4`, `openrouter/o3-mini`, `o1-2024-12-17`
- ❌ Reject: `proto3`, `ozone`, `co3`

---

## Patterns

### Pattern: Per-Model Configuration Catalog

For features that vary by model (thinking effort, token limits, etc.), use a **pattern-matching catalog** instead of hardcoding per-vendor logic:

```js
const MODEL_CATALOG = [
  // Specific models first (higher priority)
  { pattern: /gpt-5-pro/i, levels: ['high'], default: 'high', param: 'reasoning_effort' },
  { pattern: /gpt-5\.1-codex-max/i, levels: ['low','medium','high','xhigh'], default: 'medium', param: 'reasoning_effort' },
  // Generic patterns last (lower priority)
  { pattern: /\bgpt-/i, levels: ['minimal','low','medium','high'], default: 'medium', param: 'reasoning_effort' },
  { pattern: /\bo[134](?:[^a-z0-9]|$)/i, levels: ['low','medium','high'], default: 'medium', param: 'reasoning_effort' },
];

function findModelConfig(modelName) {
  return MODEL_CATALOG.find(m => m.pattern.test(modelName)) || null;
}
```

**Why**: 
- Easy to extend: add new models by appending to array
- Priority-based: specific patterns before generic
- Self-documenting: each entry shows supported levels and API format
- Most models need no vendor detection: model name directly maps to config

#### Provider-aware exception: same model name, different API payload

Some OpenAI-compatible providers expose the same model name but require different request fields. Keep the model catalog as the primary capability map, then add a small provider-aware branch inside the parameter builder only for the affected `param` mode.

**Scope / Trigger**: Use this when the model capability is model-name based, but the outbound API contract differs by configured API URL.

**Contract example**: GLM models use the same `glm-*` names across Z.AI / BigModel / Aliyun, but thinking parameters differ:

| Provider URL | Enable | Disable | Effort |
|---|---|---|---|
| `api.z.ai`, `open.bigmodel.cn` | `thinking: { type: 'enabled' }` | `thinking: { type: 'disabled' }` | top-level `reasoning_effort` for GLM-5.2+ |
| `dashscope.aliyuncs.com`, `dashscope-intl.aliyuncs.com`, `*.maas.aliyuncs.com` | `enable_thinking: true` | `enable_thinking: false` | top-level `reasoning_effort` for GLM-5.2+ |

**Good/Base/Bad cases**:
- Good: `glm-5.2` + Aliyun URL + `high` sends `{ enable_thinking: true, reasoning_effort: 'high' }`.
- Base: `glm-4.6` + BigModel URL + `enabled` sends `{ thinking: { type: 'enabled' } }`.
- Bad: `glm-5.2` + Aliyun URL sends `{ thinking: { type: 'enabled' } }`; Aliyun documents `enable_thinking`, so the intended toggle may not apply.

```js
// Specific model capability first
{ pattern: /glm-5\.2/i, levels: ['disabled','none','minimal','low','medium','high','xhigh','max'], def: 'high', param: 'glm52_thinking' },
{ pattern: /glm-/i, levels: ['disabled','enabled'], def: 'enabled', param: 'glm_thinking' },

function isAliyunGlmEndpoint(apiUrl) {
  var url = String(apiUrl || '').toLowerCase();
  return url.indexOf('dashscope.aliyuncs.com') !== -1
    || url.indexOf('dashscope-intl.aliyuncs.com') !== -1
    || url.indexOf('maas.aliyuncs.com') !== -1;
}

// Provider-aware exception stays inside the param builder.
if (entry.param === 'glm52_thinking') {
  if (isAliyunGlmEndpoint(apiUrlEl.value)) {
    if (level === 'disabled') return { enable_thinking: false };
    return { enable_thinking: true, reasoning_effort: level };
  }
  if (level === 'disabled') return { thinking: { type: 'disabled' } };
  return { thinking: { type: 'enabled' }, reasoning_effort: level };
}
```

**Tests required**: For each provider-aware exception, verify at least one enabled-level request and one disabled request per provider family. Disabled requests must not include effort fields.

---

### Pattern: Release Date Gating

For models that have different capabilities based on release date (e.g., OpenAI `gpt-5.1` needs date >= 2025-11-13):

```js
function isModelAfterDate(modelName, dateStr) {
  var dateMatch = modelName.match(/(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return true; // No date = assume new enough
  return dateMatch[1] >= dateStr;
}

// In MODEL_CATALOG:
{ pattern: /gpt-5\.1/i, levels: ['none','low','medium','high'], def: 'none', param: 'reasoning_effort', minDate: '2025-11-13' },

// In matchModelCatalog():
if (entry.minDate && !isModelAfterDate(modelName, entry.minDate)) {
  continue; // Skip this entry, try next
}
```

**Why**: Some model variants only support certain features after specific release dates. Date gating ensures correct behavior for both old and new model versions.

---

### Pattern: Toggle + Conditional Dropdown UI

For optional settings that show/hide based on context:

```html
<label class="toggle-switch">
  <input type="checkbox" id="effortToggle">
  <span class="toggle-slider"></span>
</label>
<select id="effortDropdown" class="hidden">
  <!-- Populated dynamically -->
</select>
```

```js
function updateThinkingUI() {
  const config = findModelConfig(modelName);
  
  if (!config) {
    toggleWrapper.classList.add('hidden');
    return;
  }
  
  toggleWrapper.classList.remove('hidden');
  
  // Special case: no toggle (always-on)
  if (config.noToggle) {
    toggleEl.checked = true;
    toggleWrapper.classList.add('hidden');
  }
  
  // Show dropdown when toggle is on
  effortDropdown.classList.toggle('hidden', !toggleEl.checked);
  renderDropdownItems(config.levels, config.default);
}
```

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)
