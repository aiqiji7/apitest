# Fix Model List Cache Invalidation

## Goal

Fix the frontend model-list dropdown so models fetched from one API endpoint are not reused after the user changes the API URL or API Key. The model list should reflect the currently configured connection.

## What I Already Know

* The current model-list code lives in `assets/js/script.js`.
* `cachedModels` is a single array shared across all API URL / API Key values.
* The fetch button currently reuses `cachedModels` whenever it is non-empty, so changing API URL or API Key can still show stale models from a previous connection.
* The model list is requested from `${stripTrailingSlash(apiUrl)}/v1/models` with `Authorization: Bearer <apiKey>`.

## Requirements

* Cache model-list results only for the connection that produced them.
* If the API URL or API Key changes after a successful fetch, the next fetch-button click must request `/v1/models` again instead of rendering stale cached models.
* Existing dropdown behavior should remain intact:
  * Clicking the fetch button while the current connection's cached list is open closes it.
  * Clicking the fetch button while the current connection's cached list is closed reopens it from cache.
  * Focusing the model input may show cached models, but only when the cache belongs to the current API URL / API Key.
* Preserve current error handling for missing URL/key, non-JSON responses, HTTP errors, empty model lists, and aborted requests.

## Acceptance Criteria

* [ ] After fetching models for connection A, changing API URL or API Key and clicking the fetch button triggers a new `/v1/models` request for connection B.
* [ ] Returning to the exact same connection can reuse its current in-memory cache if available, or at minimum does not show models from a different connection.
* [ ] Model input focus does not show cached models from a different API URL / API Key.
* [ ] Existing successful fetch, dropdown rendering, selection, and close behavior continue to work.
* [ ] Relevant lint/syntax checks pass for the static frontend project.

## Definition of Done

* Code updated in the frontend implementation.
* Quality check confirms no stale cross-connection cache behavior remains.
* No unrelated user changes are committed or modified.

## Technical Approach

Use a connection-aware cache key derived from the normalized API URL and API Key. Reuse cached models only when the current key matches the key used to populate the cache. When the key differs, fetch from the current endpoint instead of rendering the old cache.

This can be implemented either as:

* a single cache entry with `{ key, models }`, or
* a small map keyed by connection.

The preferred minimal approach is a single cache entry because the existing UI has one dropdown and the bug only requires preventing stale reuse.

## Decision (ADR-lite)

**Context**: The current model list cache is global and can outlive changes to API URL or API Key.

**Decision**: Make cache reuse conditional on the current connection identity.

**Consequences**: Avoids stale model lists with minimal UI changes. A future enhancement could support per-connection multi-entry caching with explicit refresh controls.

## Out of Scope

* Persisting model-list cache to localStorage.
* Adding a manual refresh button separate from the existing fetch button.
* Changing the API endpoint format or auth scheme.
* Refactoring the broader request/test flow.

## Follow-up: Manual Refresh Row (Increment)

### Goal

After the cache fix, for the same API URL + Key, clicking the fetch button only toggles the cached dropdown and never re-fetches. Add an explicit way for the user to force a fresh `/v1/models` request without changing the connection.

### Decision

Approach 2 + trigger 1: keep the cache toggle on the existing button, and add a **"刷新列表" (refresh) row at the top of the model dropdown**. Clicking that row forces a fresh fetch from the current endpoint and replaces the cached list.

### Requirements

* Render a refresh row as the first item inside the model dropdown whenever the dropdown shows a model list (`renderModelDropdown`).
* Clicking the refresh row:
  * Does NOT fill the model input (unlike model items).
  * Triggers `fetchModelsFromEndpoint()` to re-request `/v1/models` for the current URL/Key.
  * Updates the cache for the current connection and re-renders the dropdown.
* The refresh row must be visually distinguishable from model items but consistent with existing dropdown styling.
* The existing button behavior is unchanged: first click fetches, later clicks toggle cache open/close.
* Clicking the refresh row must not close the dropdown via the existing outside-click / item-click logic before the refresh completes.
* Preserve all existing error/loading/abort handling.

### Acceptance Criteria

* [ ] When the dropdown shows models, a "刷新列表" row appears at the top.
* [ ] Clicking it issues a new `/v1/models` request even when a valid cache exists for the current connection.
* [ ] Clicking it does not change the model input value.
* [ ] After refresh, the dropdown reflects the newly fetched list.
* [ ] Changing URL/Key still invalidates cache as before.
* [ ] `node --check assets/js/script.js` passes.

## Technical Notes

* Inspected `assets/js/script.js:841-969`.
* Dropdown styles: `assets/css/styles.css:1287-1340` (`.model-dropdown*`).
* Relevant project spec: `.trellis/spec/frontend/index.md`.
