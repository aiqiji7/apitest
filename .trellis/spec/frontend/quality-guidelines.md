# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

### Don't: Create duplicate message cards in streaming+tool-call paths

**Problem**:
```js
// During streaming: creates card A
assistantCard = addMessage('assistant', '回答（流式）', fullText);
// After streaming ends: creates card B (duplicate!)
addMessage('assistant', '模型响应 #1', assistantMsg);
```

**Why it's bad**: Users see two assistant cards for the same turn — a truncated streaming card and a final structured card. The streaming card shows partial text that looks like a broken, incomplete message.

**Instead**:
```js
// During streaming: creates card A
assistantCard = addMessage('assistant', '回答（流式）', fullText);
// After streaming ends: UPDATE card A, don't create card B
updateMessageCard(assistantCard, '模型响应 #1', assistantMsg);
```

### Don't: Use CSS `:empty` / `::after` on streaming content containers

**Problem**:
```css
pre.answer-content:empty {
  border: 2px dashed red;
}
pre.answer-content:empty::after {
  content: '（模型未输出正式回答）';
}
```

**Why it's bad**: During streaming, if reasoning/thinking content arrives before text content, the `<pre>` element is briefly empty. The `:empty` pseudo-class triggers a flash of red border + placeholder text that disappears the instant text content arrives, causing visual flicker.

**Instead**: Handle empty-state display in JS after streaming completes (e.g., check `accumulatedText` and set `pre.textContent` explicitly). Use `min-height` on the base rule to prevent layout collapse when empty.

---

## Required Patterns

### Required Pattern: Sanitize User-Visible Fetch Errors

User-visible fetch errors may include backend response bodies or attempted URLs. Always sanitize before rendering:

- Mask `sk-...` OpenAI-style keys.
- Mask `Bearer ...` and obvious `api_key`, `token`, `authorization`, `secret`, `password`, or `cookie` values.
- Remove URL credentials and sensitive query parameters.
- Prefer `textContent` over string-concatenated HTML when rendering user-controlled error content.

Example:

```js
function sanitizeSensitiveText(text) {
  return String(text || '')
    .replace(/(sk-)[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/([?&#;](?:api[_-]?key|token|access_token|authorization|secret|password|cookie)=)[^&#;\s]+/gi, '$1***')
    .trim();
}
```

---

## Testing Requirements

<!-- What level of testing is expected -->

(To be filled by the team)

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
