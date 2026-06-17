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

<!-- Patterns that should never be used and why -->

(To be filled by the team)

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
