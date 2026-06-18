# Display Request Headers in Frontend

## Goal

Show request headers alongside the existing request body in the frontend request/response panel, while keeping sensitive values masked or otherwise non-revealing in the UI. Also add two model IQ test items to the test content area.

## What I already know

- The project is a plain frontend app built with `index.html` and `assets/js/script.js`.
- Request payloads are already rendered through `addBlock('请求 #...')` in `assets/js/script.js`.
- The app already has sanitization helpers for sensitive text and URLs.
- The user wants the frontend to display request headers, not only the request body.
- Sensitive key information should not be shown in plaintext.
- The user also wants two new model IQ test items in the test content selector.
- IQ test 1 expected answer: `5`; expected thinking/response time: long, about 2+ minutes.
- IQ test 2 expected answer: `21`; expected thinking/response time: about 2 minutes.

## Assumptions (temporary)

- The new UI should remain consistent with the existing request/response blocks.
- The implementation should cover the request headers actually sent by each scenario.
- Sensitive values can be masked in the UI instead of being stored or exposed in plaintext.
- Code blocks (request/response) currently have no collapse toggle and occupy too much vertical space.
- Long single-line pre content does not wrap, requiring horizontal scrolling.
- Response rendering is not streaming; it waits for the full response body before displaying.
- Displayed request headers only include explicitly-set headers; browser-auto headers are not capturable via `fetch()` but this limitation should be documented.
- IQ test scenarios may trigger "无法连接API" errors due to long prompts or timeout-related issues.

## Open Questions

- None.

## Requirements (evolving)

- Render request headers for each request block in the request/response panel.
- Keep the request body display unchanged.
- Show ordinary request header values directly.
- Mask sensitive request header values, including key/auth/token/cookie-like headers.
- Preserve the current visual style and copy behavior as much as possible.
- Add `模型智商测试题 1` and `模型智商测试题 2` as selectable test items in the test content area.
- The IQ test items should fill the user message with the exact supplied prompt text.
- The IQ test items should send a normal single-turn text request for the currently selected vendor.
- Show or otherwise preserve the reference answer metadata so the user can compare the model's response: test 1 = `5`, test 2 = `21`.
- Add collapse/expand toggle to each code-block so only the title is visible by default.
- Enable word wrapping for long single-line content in code-block and card pre elements.
- Replace `fetchAndParse` with streaming response rendering for all scenarios.
- Document the `fetch()` header limitation in the request header display.
- Ensure IQ test scenarios gracefully handle connection errors and long-running requests.

## Acceptance Criteria (evolving)

- [ ] Each rendered request block shows a header section in addition to the request body.
- [ ] Ordinary headers such as `Content-Type` and vendor/version headers are visible.
- [ ] Sensitive headers such as `Authorization` and `x-api-key` are masked.
- [ ] Existing request body rendering still works.
- [ ] The new display is consistent across the main request scenarios used by the app.
- [ ] The test content selector includes `模型智商测试题 1` and `模型智商测试题 2`.
- [ ] Selecting each IQ test populates the textarea with the corresponding prompt.
- [ ] Sending each IQ test uses the selected vendor's normal text API path and renders request/response blocks.
- [ ] The UI gives the user enough reference information to compare the expected answer (`5` or `21`) and observed response duration.
- [ ] Code blocks have a collapse/expand toggle; by default only the title is visible.
- [ ] Long single-line content in code-block and card pre elements wraps automatically.
- [ ] Response content renders incrementally as streaming chunks arrive.
- [ ] The request header display includes a note about browser `fetch()` header limitations.
- [ ] IQ test scenarios show meaningful error messages instead of raw "无法连接 API" when appropriate.
- [ ] All existing scenarios (tools, search, image) still work with streaming.

## Streaming Implementation Notes

- OpenAI Chat Completions: SSE format, each `data: {"choices":[{"delta":...}]}` line yields content chunks.
- Anthropic Messages: SSE format, `event: content_block_delta` and `event: message_delta` events.
- Gemini generateContent: SSE format with `data:` prefixed lines containing candidates/content.
- Streaming helper should accept callbacks for chunk rendering and work with existing `addBlock`/`addMessage` patterns.
- AbortController integration must work during streaming.

## Definition of Done

- UI behavior implemented and manually verified in the browser.
- Lint/type-check or equivalent project checks pass where applicable.
- Sensitive values remain masked in visible request header output.

## Out of Scope

- Changing the API request payloads themselves.
- Persisting request history outside the browser.
- Introducing backend changes.
- Automatic pass/fail judgment based on response content or exact response duration.

## Technical Notes

- Likely implementation point: `assets/js/script.js` `addBlock()` and the request-building call sites.
- Test type configuration lives in `assets/js/script.js` `vendorTests` and `applyScenarioInput()`.
- Existing sanitization helpers: `sanitizeSensitiveText()` and `sanitizeUrlForDisplay()`.
- Relevant frontend guidelines: `.trellis/spec/frontend/index.md`, `.trellis/spec/frontend/quality-guidelines.md`, `.trellis/spec/frontend/component-guidelines.md`, `.trellis/spec/frontend/directory-structure.md`, `.trellis/spec/frontend/type-safety.md`.

## IQ Test Prompts

### 模型智商测试题 1

Expected answer: `5`.

Expected thinking/response time: about 2+ minutes.

Prompt:

```text
首先我想请你回答一道困难的计算题。设实数列{x_n}满足：x_0=0，x_2=\sqrt[3]{2}x_1，x_3 是正整数，且 x_{n+1} = \frac{1}{\sqrt[3]{4}} x_n + \sqrt[3]{4} x_{n-1} + \frac{1}{2} x_{n-2} (n \geq 2)。问：这类数列中最少有多少个整数项？计算出答案之后请使用JSON格式回答以下所有问题：上个计算题的答案是多少？告诉我你是什么AI模型，版本号多少，你的知识截止日期是什么时候，训练和发布你的公司是什么？
```

### 模型智商测试题 2

Expected answer: `21`.

Expected thinking/response time: about 2 minutes.

Prompt:

```text
在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）

苹果味	桃子味	西瓜味
圆形	7	9	8
五角星形	7	6	4
```

## Decision (ADR-lite)

**Context**: Request blocks currently show payloads but not the headers sent with the fetch call, making it harder to inspect provider-specific auth/version/content-type behavior.

**Decision**: Extend request block rendering so request headers are displayed next to the request body. Use partial masking: normal headers remain visible, while sensitive headers such as `Authorization`, `x-api-key`, token, cookie, secret, password, and API-key-like names are masked.

**Consequences**: The UI becomes more useful for debugging without exposing raw credentials. Copy output should avoid leaking masked values when copying displayed request details.

**Additional Decision**: Add the IQ tests as vendor-agnostic text scenarios available under each vendor. They should use the selected vendor's standard text request path and show reference answer/duration metadata for manual comparison instead of automatic pass/fail scoring.
