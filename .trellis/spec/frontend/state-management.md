# State Management

> How state is managed in this project.

---

## Overview

<!--
Document your project's state management conventions here.

Questions to answer:
- What state management solution do you use?
- How is local vs global state decided?
- How do you handle server state?
- What are the patterns for derived state?
-->

(To be filled by the team)

---

## State Categories

<!-- Local state, global state, server state, URL state -->

(To be filled by the team)

---

## When to Use Global State

<!-- Criteria for promoting state to global -->

(To be filled by the team)

---

## Server State

<!-- How server data is cached and synchronized -->

### Convention: Bind API-derived caches to their input identity

**What**: Any frontend cache populated from an API call must store the input identity that produced it, such as normalized base URL, API key, selected account, query, or other request-defining fields.

**Why**: This prevents stale server data from one connection or query being shown after the user changes the inputs.

**Example**:

```js
const cacheKey = `${normalizedApiUrl}::${apiKey}`;
const cachedModels = { key: cacheKey, models };

if (cachedModels.key === getCurrentCacheKey()) {
  renderModelDropdown(cachedModels.models);
}
```

**Validation**: When any field used to build the request changes, the UI must either fetch fresh data or prove the cached key still matches before rendering cached results.

---

## Common Mistakes

<!-- State management mistakes your team has made -->

### Common Mistake: Reusing API cache across changed inputs

**Symptom**: A dropdown or preview still shows data from the previous API URL / key after the user edits connection fields.

**Cause**: The cache stores only the response data, not the request identity that created it.

**Fix**: Store a cache key alongside the response and check it before rendering. If the key differs, fetch fresh data instead of showing stale cache.
