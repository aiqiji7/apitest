// node tests/desktop-layout.e2e.mjs [--head | --streaming-only | --views-only | --panels-only]
// APITEST_LAYOUT_ARTIFACTS=/path/to/screenshots APITEST_E2E_CHROME=/path/to/chrome
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdtempDisposable, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const revision = process.argv.includes('--head') && execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const streamingOnly = process.argv.includes('--streaming-only');
const viewsOnly = process.argv.includes('--views-only');
const panelsOnly = process.argv.includes('--panels-only');
assert.ok([revision, streamingOnly, viewsOnly, panelsOnly].filter(Boolean).length <= 1, 'Choose one verification mode');
let artifacts = process.env.APITEST_LAYOUT_ARTIFACTS;
const fakeKey = 'sk-layout-local-fixture-only';
const configFixture = 'window.APP_CONFIG = {apiUrl:"", apiKey:"", model:"gpt-5.1"};';
// The same meaningful prose is used at every acceptance height; no artificial
// newline padding or viewport-dependent shortening may make the answer fit.
const representativeAnswer = [
  '连接配置：先确认服务地址、模型名称和访问凭证是否正确，再选择要验证的协议。配置只用于当前浏览器中的测试操作，结果中的请求头会按原来的规则隐藏敏感字段。展开原始记录时，可以把实际发送的请求体与返回内容逐项核对，避免把调用格式的问题误判为模型能力的问题。',
  '测试准备：工具调用、图片识别、搜索和普通文本分别验证不同能力。选择测试项后，应先阅读当前消息与参数，再决定是否运行。对于固定的验证题目，页面会保留自动生成的输入；对于可以编辑的消息，可以使用自己的短问题验证服务连通性，然后逐步增加请求的复杂程度。',
  '结果阅读：对话区域按照用户消息、模型回答和工具执行的顺序展示内容。用户消息可以展开回看，正式回答始终保留完整文本。原始请求与响应放在独立的对照栏中，需要检查字段或复制记录时再展开，能够给主要回答留下更宽的阅读空间，减少换行带来的额外滚动。',
  '流式响应：请求尚未完成时，模型已经生成的文字会持续更新。阅读位置在底部时，消息栏跟随最新输出；向上翻看较早内容后，自动跟随会暂停。回到最下方即可继续跟随。这个行为只影响消息栏，不改变左侧配置、测试表单和原始请求记录各自的阅读位置。',
  '工具流程：工具测试可能包含多轮模型回复与本地执行结果。每一轮都会保留相应消息，便于检查模型是否给出了合法参数，以及后续回答是否使用了工具结果。出现最终验证提示时，应同时核对回答内容与工具参数，不能仅凭一条成功状态推断所有场景都会得到同样的结果。',
  '思考内容：部分服务会返回独立的思考文本。生成过程中可以观察文字增长，完成后仍能通过原有的展开入口查看。如果服务只返回思考而没有正式回答，页面会给出对应提示。思考文本与正式回答分别保留，不把暂时为空的回答区当作失败，也不生成未经模型返回的说明。',
  '错误定位：有明确响应状态时，应结合状态码和已经隐藏敏感信息的返回摘要定位问题。浏览器没有收到响应时，只能检查地址、服务、跨域或代理等可能原因。错误提示应留在当前可见区域，运行与停止按钮仍可访问，以便用户在调整参数后重新尝试。',
  '结构化输出：这个测试检查固定对象中的字段、类型和额外属性，结果只说明当前结构是否符合约定。阅读验证详情时，应对照模型实际返回的内容，特别关注数字是否为整数、必需字段是否完整，以及对象中是否出现了没有声明的属性。小规模验证不代表覆盖所有结构。',
  '容量测试：每次尝试都会消耗请求次数与输入预算，因此开始前应确认起点和分辨率。结果中的本地目标估算与服务端用量采用不同口径，查看上下界时应保留这种区别。遇到鉴权、限流或参数错误时，也不应直接把错误位置解释为模型的最大上下文限制。',
  '指纹样本：自动采样与手动粘贴使用相同的本地分析入口，三份样本分别保留在卡片中。排名来自当前参考库中的比较，库外模型也可能得到相似候选。查看结果时，应结合有效数字数量和原始样本判断可靠程度，保留完整排名与来源说明，不把首位候选当作身份认证。',
  '对照检查：需要排查请求格式时，展开请求与响应栏，查看协议、字段和返回数据是否符合预期。折叠栏位只改变阅读空间，不能重建消息、清空内容或改变原始块的展开状态。重新打开后，应能从先前的位置继续查看和复制已经隐藏敏感信息的记录。',
  '使用建议：先用短请求确认连接，再验证工具或结构化约束，最后运行较昂贵的容量与多次采样测试。阅读普通回答时优先保留主要结果，遇到很长的回复或多轮过程时再滚动查看全部内容。所有折叠入口都可以随时恢复，当前输入和结果不因切换视图而丢失。',
].join('\n');
const mock = { requests: [], pending: [], streams: [], errors: [], diagnostic: null };
const previewDocument = '<!DOCTYPE html><html><head><title>Local preview</title></head><body><h1>LOCAL_LAYOUT_PREVIEW</h1><p>本地预览结果</p></body></html>';
const sourceFiles = ['index.html', 'assets/css/styles.css', 'assets/js/script.js', 'assets/js/testing-core.js',
  'assets/js/fingerprint.js', 'assets/js/capability.js'];
const sourceBytes = file => revision
  ? execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, maxBuffer: 16 << 20 }) : readFile(join(root, file));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await sourceBytes(file))])));
}
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const file = new URL(req.url, 'http://localhost').pathname.slice(1);
  if (req.method === 'POST' && file === 'v1/chat/completions') {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert.ok(size < 1 << 20, 'Unexpectedly large layout mock request');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const record = { method: req.method, path: req.url, body, fakeAuthorization: req.headers.authorization === `Bearer ${fakeKey}` };
      mock.requests.push(record);
      res.once('close', () => { record.closed = true; record.aborted = !res.writableFinished; });
      if (mock.diagnostic && body.stream === false) {
        const prompt = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n');
        record.kind = prompt.startsWith('Return JSON describing the city of Lisbon') ? 'structured'
          : prompt.includes('Question: Return only the archive code for record') ? 'needle'
            : prompt.startsWith('Reference note ') ? 'capacity' : 'unknown-diagnostic';
        assert.notEqual(record.kind, 'unknown-diagnostic', 'Only native diagnostic prompts may use automatic mock replies');
        let content = 'OK', status = 200;
        const inputTokens = Math.ceil(prompt.length / 4);
        if (mock.diagnostic.parameterError) {
          status = 400; content = 'Local diagnostic parameter is not supported';
          record.parameterError = true;
        } else if (record.kind === 'structured') content = JSON.stringify({ city: 'Lisbon', population: 545000, coastal: true });
        else if (record.kind === 'needle') {
          const key = prompt.match(/Question: Return only the archive code for record "(archive-[0-9a-f]+)"/)?.[1];
          assert.ok(key, 'Needle question must identify the actual generated record');
          content = prompt.match(new RegExp(`Record "${key}" has archive code "([0-9a-f]{32})"`))?.[1];
          assert.ok(content, 'Needle answer must be extracted from the actual request');
        } else if (inputTokens > 6000) {
          status = 400; content = 'maximum context length is 6000 tokens';
        }
        record.status = status; record.inputTokens = inputTokens;
        const json = status === 200 ? { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: inputTokens, completion_tokens: 1 } }
          : { error: { message: content, code: record.parameterError ? 'invalid_request_error' : 'context_length_exceeded' } };
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(json));
        return;
      }
      if (body.stream === true) {
        record.frames = [];
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const stream = { record, emit(delta) {
          assert.ok(!res.destroyed && !res.writableEnded, 'Mock SSE must remain open until explicitly released');
          record.frames.push({ fields: Object.keys(delta), characters: Object.values(delta).join('').length });
          res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
        }, release() {
          if (res.destroyed || res.writableEnded) return;
          record.released = true;
          res.end('data: [DONE]\n\n');
        } };
        mock.streams.push(stream); mock.pending.push(stream);
        return;
      }
      mock.pending.push({ record, release() {
        if (res.destroyed || res.writableEnded) return;
        record.released = true;
        const preview = body.messages?.some(message => message.role === 'user' && message.content === 'LOCAL_LAYOUT_PREVIEW');
        if (preview) record.kind = 'preview';
        const content = preview ? previewDocument : 'LAYOUT_LOCAL_COMPLETION\n' + '本地响应：用于检查消息栏滚动。\n'.repeat(100);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      } });
    } catch (error) {
      mock.errors.push(error.message);
      if (!res.headersSent) res.writeHead(500).end(); else res.destroy();
    }
    return;
  }
  if (req.method !== 'GET' || !(file === 'index.html' || /^assets\/[\w./-]+$/.test(file))) return res.writeHead(404).end();
  try {
    // Never read developer credentials. The only API is the manually released same-origin mock above.
    const body = file === 'assets/js/config.js' ? configFixture
      : file === 'assets/layout-fixture.svg' ? '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#cfe6ff"/></svg>'
        : await sourceBytes(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'" }).end(body);
  } catch { res.writeHead(404).end(); }
});

// Chrome's private CDP pipe: no debugging port, installed packages or shared browser profile.
function connect(chrome) {
  let serial = 0, buffer = '', sessionId;
  const pending = new Map();
  const diagnostics = { runtimeErrors: [], consoleErrors: [], requests: [], loadingFailures: [] };
  chrome.stdio[4].setEncoding('utf8').on('data', chunk => {
    const messages = (buffer + chunk).split('\0');
    buffer = messages.pop();
    for (const frame of messages) {
      const msg = JSON.parse(frame);
      if (pending.has(msg.id)) pending.get(msg.id)(msg);
      else if (msg.method === 'Runtime.exceptionThrown') diagnostics.runtimeErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        diagnostics.consoleErrors.push(msg.params.args.map(arg => String(arg.value ?? arg.description ?? '')).join(' '));
      } else if (msg.method === 'Network.requestWillBeSent') {
        const { url, method } = msg.params.request;
        diagnostics.requests.push({ url, method });
      } else if (msg.method === 'Network.loadingFailed') {
        const { requestId, canceled, errorText } = msg.params;
        diagnostics.loadingFailures.push({ requestId, canceled, errorText });
      }
    }
  });
  function send(method, params = {}) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 12000);
      pending.set(id, msg => {
        pending.delete(id); clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`)); else resolve(msg.result);
      });
      chrome.stdio[3].write(JSON.stringify({ method, params, sessionId, id }) + '\0');
    });
  }
  async function evaluate(fn, ...args) {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }
  async function attach() {
    const { targetInfos } = await send('Target.getTargets');
    const { targetId } = targetInfos.find(t => t.type === 'page');
    ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  }
  return { send, evaluate, attach, diagnostics };
}

// Browser-side. Intersect with each scrollport's *client* box (not just the viewport).
// Deliberately no focus, scrolling or mutations here: those would mask first-paint regressions.
function measure(selectors) {
  const root = document.scrollingElement;
  const boxes = {}, clipped = [];
  for (const s of selectors) {
    const elements = [...document.querySelectorAll(s)];
    if (!elements.length) clipped.push(`${s}: absent`);
    for (const el of elements) {
      const r = el.getBoundingClientRect();
      boxes[s] = [r.x, r.y, r.width, r.height].map(Math.round);
      let l = 0, t = 0, b = document.documentElement.clientHeight, h = document.documentElement.clientWidth;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p), pr = p.getBoundingClientRect();
        if (cs.overflowY !== 'visible') { t = Math.max(t, pr.top + p.clientTop); b = Math.min(b, pr.top + p.clientTop + p.clientHeight); }
        if (cs.overflowX !== 'visible') { l = Math.max(l, pr.left + p.clientLeft); h = Math.min(h, pr.left + p.clientLeft + p.clientWidth); }
      }
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!el.checkVisibility() || !r.width || !r.height || r.top < t - 1 || r.bottom > b + 1 ||
          r.left < l - 1 || r.right > h + 1 || (!el.disabled && !el.contains(hit))) {
        clipped.push(`${s} ${el.id || el.dataset.scenario || ''} [${boxes[s]}] clip=[${[l,t,h,b].map(Math.round)}]`);
      }
    }
  }
  return { boxes, clipped, viewport: [innerWidth, innerHeight], overflow: [root.scrollWidth - root.clientWidth, root.scrollHeight - root.clientHeight],
    pageScroll: [scrollX, scrollY] };
}

const actions = ['#testBtn', '#stopTestBtn', '#clearBtn'];
const headings = ['#timelineColumn h3', '#blocksColumn h3'];
const viewControls = ['#resultsTitle', '#workspaceSetupToggle', '#workspaceLogsToggle'];
const controls = ['#manageConfigBtn', '#apiUrl', '#showRecentConnectionsBtn', '#apiKey', '#model', '#fetchModelsBtn',
  '#proxyToggle', '#profileSelect button', '#profileAdvancedDetails > summary', '.stream-toggle-label',
  '#vendorType button', '#openaiProtocol button', '#testType button'];
const tracks = ['.config-section', '.test-controls', '#timelineColumn', '#blocksColumn'];
const scrollOwners = ['.config-body', '.test-form', '#timelineColumn', '#blocksColumn', '#capabilityPanel', '#fingerprintPanel',
  '.main-card', '.test-section', '.workspace-results', '.split-columns'];

function scrollState(selectors) {
  return { page: [scrollX, scrollY], panes: Object.fromEntries(selectors.map(s => {
    const el = document.querySelector(s); return [s, el ? [el.scrollLeft, el.scrollTop] : null];
  })) };
}

// Measure the actual streamed text with a read-only Range; adding a sentinel or
// scrolling it into view would change the layout/scroll behavior being tested.
function measureStreamTail(selector, marker) {
  const pre = [...document.querySelectorAll(selector)].at(-1);
  if (!pre) return { found: false, visible: false };
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  let node, offset = -1;
  while ((node = walker.nextNode()) && (offset = node.textContent.indexOf(marker)) < 0) { /* scan text nodes */ }
  if (!node) return { found: false, visible: false };
  const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + marker.length);
  const r = range.getBoundingClientRect(), timeline = pre.closest('#timelineColumn');
  let left = 0, top = timeline.querySelector('h3').getBoundingClientRect().bottom;
  let right = document.documentElement.clientWidth, bottom = document.documentElement.clientHeight;
  for (let p = pre; p; p = p.parentElement) {
    const css = getComputedStyle(p), box = p.getBoundingClientRect();
    if (css.overflowY !== 'visible') { top = Math.max(top, box.top + p.clientTop); bottom = Math.min(bottom, box.top + p.clientTop + p.clientHeight); }
    if (css.overflowX !== 'visible') { left = Math.max(left, box.left + p.clientLeft); right = Math.min(right, box.left + p.clientLeft + p.clientWidth); }
  }
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { found: true, visible: pre.checkVisibility() && r.width > 0 && r.height > 0 &&
    r.left >= left - 1 && r.right <= right + 1 && r.top >= top - 1 && r.bottom <= bottom + 1 && pre.contains(hit),
    rect: [r.x, r.y, r.width, r.height].map(Math.round), clip: [left, top, right, bottom].map(Math.round),
    timeline: { top: timeline.scrollTop, height: timeline.clientHeight, content: timeline.scrollHeight },
    pre: { top: pre.scrollTop, height: pre.clientHeight, content: pre.scrollHeight, overflowY: getComputedStyle(pre).overflowY } };
}

async function until(probe, why) {
  for (const end = Date.now() + 6000; Date.now() < end; await delay(40)) if (await probe()) return;
  throw new Error(`Timed out: ${why}`);
}

async function suite(browser, origin, report) {
  const { send, evaluate } = browser;
  const click = s => evaluate(s => document.querySelector(s).click(), s);
  const select = id => click(`#testType [data-scenario="${id}"]`);
  const shot = async name => {
    if (!artifacts) return;
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = join(artifacts, `${name}.png`), bytes = Buffer.from(data, 'base64');
    await writeFile(file, bytes);
    report.screenshots.push({ file, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
  };
  async function visit(width, height) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const url = `${origin}/index.html?w=${width}&h=${height}`;
    await send('Page.navigate', { url });
    await until(() => evaluate(url => location.href === url && document.readyState === 'complete' && !!window.APITestBridge, url), 'fresh page');
  }
  const fullRun = !revision && !streamingOnly && !viewsOnly && !panelsOnly;
  function fits(m, wide = true) {
    assert.ok(m.overflow[0] <= 1, `horizontal overflow: ${m.overflow}`);
    if (wide) { assert.ok(m.overflow[1] <= 1, `vertical overflow: ${m.overflow}`); assert.deepEqual(m.pageScroll, [0, 0]); }
    assert.deepEqual(m.clipped, [], 'hidden, clipped or overlapped elements: ' + m.clipped.join('; '));
  }
  async function key(key, code) {
    for (const type of [key === 'Enter' ? 'keyDown' : 'rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', {
      type, key, code: key, windowsVirtualKeyCode: code, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}),
    });
  }
  const positions = () => evaluate(scrollState, scrollOwners);
  const focus = s => evaluate(s => document.querySelector(s).focus(), s);
  async function pointerClick(s, wide = true) {
    fits(await evaluate(measure, [s]), wide);
    const [x, y] = await evaluate(s => {
      const r = document.querySelector(s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
    }, s);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  async function view({ setup, logs }, keyboard = false) {
    for (const [id, open] of [['workspaceSetupToggle', setup], ['workspaceLogsToggle', logs]]) {
      if (open === undefined) continue;
      const selector = `#${id}`;
      if (await evaluate((selector, open) => document.querySelector(selector)?.getAttribute('aria-expanded') === String(open), selector, open)) continue;
      if (keyboard) { await focus(selector); await key('Enter', 13); await focused(selector); }
      else await pointerClick(selector);
      assert.equal(await evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded'), selector), String(open));
    }
  }
  const comparison = () => view({ setup: true, logs: true });
  const fill = (id, value) => evaluate((id, value) => {
    const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
  }, id, value);
  async function localConnection() {
    await fill('apiUrl', origin); await fill('apiKey', fakeKey); await fill('model', 'gpt-5.1');
  }
  async function wheel(s, deltaY) {
    const [x, y] = await evaluate(s => {
      const r = document.querySelector(s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
    }, s);
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  }
  async function focused(s, target = s, wide = true, visible = target) {
    assert.ok(await evaluate(s => document.activeElement === document.querySelector(s), s), `keyboard focus: ${s}`);
    const outline = await evaluate(s => {
      const css = getComputedStyle(document.querySelector(s)); return { style: css.outlineStyle, width: parseFloat(css.outlineWidth), color: css.outlineColor };
    }, target);
    assert.ok(outline.style !== 'none' && outline.width >= 2 && outline.color !== 'rgba(0, 0, 0, 0)', `visible focus: ${target} ${JSON.stringify(outline)}`);
    await until(async () => !(await evaluate(measure, [visible])).clipped.length, `focused content visible: ${visible}`);
    fits(await evaluate(measure, [visible]), wide);
  }
  function onlyPaneMoved(before, after, pane) {
    assert.deepEqual(after.page, before.page, 'local scrolling moved the document');
    assert.notDeepEqual(after.panes[pane], before.panes[pane], `${pane} did not scroll`);
    for (const s of scrollOwners.filter(s => s !== pane)) assert.deepEqual(after.panes[s], before.panes[s], `local scrolling moved ${s}`);
  }

  // Drive the actual scroll owner with End or a wheel. Moving only the document,
  // a capped <pre>, or a competing outer pane is not a successful reachability check.
  async function reachEnd(pane, last, how, fixed) {
    assert.ok((await evaluate(measure, [last])).clipped.length, `fixture too short: ${last}`);
    const before = await positions();
    const [x,y] = await evaluate((pane, last, how) => {
      const region = document.querySelector(pane);
      let p = document.querySelector(last).parentElement;
      while (p && !(p.scrollHeight > p.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
      if (!p || !region.contains(p) || p.matches('pre,textarea')) throw new Error(`No local result scrollport: ${pane}`);
      if (how === 'keyboard') { p.focus({ preventScroll: true }); if (document.activeElement !== p) throw new Error(`Cannot focus ${pane}`); }
      const r = p.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
    }, pane, last, how);
    if (how === 'keyboard') await key('End', 35);
    else await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 20000 });
    await until(async () => !(await evaluate(measure, [last])).clipped.length, `${how} reaches ${last}`);
    fits(await evaluate(measure, [...actions, ...fixed, last]));
    const after = await positions();
    onlyPaneMoved(before, after, pane);
    if (how === 'keyboard') await focused(pane);
    return { before, after };
  }

  async function configStress() {
    await visit(1920, 900);
    await comparison();
    await click('#manageConfigBtn');
    fits(await evaluate(measure, ['#configModalTitle', '#configName', '#configUrl', '#configKey', '#configModel', '#saveConfigBtn', '#closeConfigModal']));
    await key('Escape', 27);
    await click('#profileSelect [data-profile="codex"]');
    await click('#proxyToggle');
    await click('#profileAdvancedDetails summary');
    await click('#profileCustomHeadersDetails summary');
    const before = await positions();
    assert.ok((await evaluate(measure, ['#profileCustomHeaders'])).clipped.length, 'expanded config must exercise local overflow');
    await focus('#profileCustomHeadersDetails summary');
    await key('Tab', 9); await focused('#profileCustomHeaders');
    fits(await evaluate(measure, [...actions, ...headings]));
    const keyboard = await positions(); onlyPaneMoved(before, keyboard, '.config-body');
    await shot('config-expanded-keyboard-1920x900');
    await wheel('.config-body', -20000);
    await until(() => evaluate(() => document.querySelector('.config-body').scrollTop === 0), 'configuration returns to top');
    await wheel('.config-body', 20000);
    await until(async () => !(await evaluate(measure, ['#profileCustomHeaders'])).clipped.length, 'pointer reaches final custom header field');
    await pointerClick('#profileCustomHeaders');
    assert.ok(await evaluate(() => document.activeElement.id === 'profileCustomHeaders'));
    fits(await evaluate(measure, [...actions, ...headings, '#profileCustomHeaders']));
    report.observations.expandedConfig = { before, keyboard, pointer: await positions() };
  }

  async function dropdowns() {
    await visit(1920, 900);
    await comparison();
    // Long lists use the production scroll containers/item classes, without changing controller data or sending model-list requests.
    const evidence = [];
    for (const [id, cls] of [['modelDropdown', 'model-dropdown-item'], ['recentDropdown', 'recent-dropdown-item'], ['effortDropdown', 'effort-dropdown-item']]) {
      await evaluate((id, cls) => {
        for (const s of ['#modelDropdown', '#recentDropdown', '#effortDropdown']) document.querySelector(s).style.display = 'none';
        if (id === 'effortDropdown') document.querySelector('#effortSelectWrapper').style.display = '';
        const list = document.getElementById(id);
        list.replaceChildren(...Array.from({ length: 50 }, (_, i) => {
          const item = document.createElement('div'); item.className = cls; item.textContent = `本地选项 ${i + 1}`;
          return item;
        }));
        list.style.display = ''; list.scrollTop = 0;
      }, id, cls);
      const pane = `#${id}`, last = `${pane} > :last-child`;
      await focus(pane); await key('End', 35);
      await until(() => evaluate(s => {
        const p = document.querySelector(s); return p.scrollTop + p.clientHeight >= p.scrollHeight - 1;
      }, pane), `End scrolls ${pane}`);
      await focused(pane);
      fits(await evaluate(measure, [...actions, ...headings, last]));
      // Reset the fixture before testing the independent wheel path.
      await evaluate(s => { document.querySelector(s).scrollTop = 0; }, pane);
      await wheel(pane, 20000);
      await until(async () => !(await evaluate(measure, [last])).clipped.length, `wheel reaches ${pane} final option`);
      fits(await evaluate(measure, [...actions, ...headings, last]));
      evidence.push({ pane, scroll: await evaluate(s => {
        const p = document.querySelector(s); return { top: p.scrollTop, height: p.clientHeight, content: p.scrollHeight };
      }, pane) });
    }
    report.observations.dropdownFixtures = evidence;
  }

  async function imageStress() {
    await visit(1920, 900);
    await comparison();
    await select('openai_image');
    await until(() => evaluate(() => document.querySelector('#previewImg').complete && document.querySelector('#previewImg').naturalWidth > 0), 'embedded image decoded');
    await evaluate(() => { document.querySelector('#userInput').style.height = '1100px'; });
    await focus('#userInput'); await key('Tab', 9);
    await focused('#imageFileInput', '.file-upload-btn');
    fits(await evaluate(measure, [...actions, ...headings]));
    await key('Tab', 9); await focused('#imageUrlInput');
    // Enter invokes the actual URL-preview handler, fetching a same-origin deterministic image.
    await evaluate(origin => { document.querySelector('#imageUrlInput').value = `${origin}/assets/layout-fixture.svg`; }, origin);
    await key('Enter', 13);
    await until(() => evaluate(() => {
      const img = document.querySelector('#previewImg'); return img.complete && img.naturalWidth === 320;
    }), 'same-origin URL preview decoded');
    await key('Tab', 9); await focused('#removeImageBtn');
    fits(await evaluate(measure, [...actions, ...headings, '#previewImg']));
    assert.ok(await evaluate(() => document.querySelector('.test-form').scrollTop > 0));
    assert.deepEqual((await positions()).panes['.config-body'], [0, 0]);
    await shot('image-preview-keyboard-1920x900');
    await wheel('.test-form', -20000);
    await until(() => evaluate(() => document.querySelector('.test-form').scrollTop === 0), 'image form returns to top');
    await wheel('.test-form', 20000);
    await until(async () => !(await evaluate(measure, ['#removeImageBtn'])).clipped.length, 'pointer reaches image removal');
    fits(await evaluate(measure, [...actions, ...headings, '.file-upload-btn', '#imageUrlInput', '#previewImg']));
    await pointerClick('#removeImageBtn');
    assert.equal(await evaluate(() => document.querySelector('#imagePreview').checkVisibility()), false);
    fits(await evaluate(measure, [...actions, ...headings]));
  }

  async function ordinaryStress() {
    await visit(1920, 900);
    await comparison();
    await evaluate(() => {
      for (const [id, cls] of [['messageTimeline', 'card message assistant'], ['blocksContainer', 'code-block']]) {
        const card = document.createElement('div'), pre = document.createElement('pre'), end = document.createElement('span');
        card.className = cls; pre.className = 'answer-content';
        pre.textContent = '本地布局检查 '.repeat(8) + '\n' + ('x'.repeat(150) + '\n').repeat(50);
        end.id = `${id}End`; end.textContent = '最后一行';
        pre.append(end); card.append(pre); document.getElementById(id).append(card);
      }
    });
    fits(await evaluate(measure, [...actions, ...headings]));
    report.observations.resultScrolls = {
      timeline: await reachEnd('#timelineColumn', '#messageTimelineEnd', 'keyboard', headings),
      blocks: await reachEnd('#blocksColumn', '#blocksContainerEnd', 'wheel', headings),
    };
    await shot('ordinary-long-results-1920x900');
  }

  async function ordinaryRequest(reducedMotion) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }] });
    await visit(1920, 900);
    await comparison();
    await click('#profileSelect [data-profile="codex"]');
    await click('#proxyToggle'); await click('#profileAdvancedDetails summary'); await click('#profileCustomHeadersDetails summary');
    await click('#openaiProtocol [data-protocol="chat_completions"]');
    await select('iq_test_1');
    await evaluate((origin, fakeKey) => {
      for (const [id, value] of [['apiUrl', origin], ['apiKey', fakeKey], ['model', 'gpt-5.1']]) {
        const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('#streamToggle').checked = false;
      const input = document.querySelector('#userInput'); input.value = 'LOCAL_LAYOUT_REQUEST\n' + '本地长消息，用于展开后对照请求。\n'.repeat(120);
      input.style.height = '1100px';
      document.querySelector('.config-body').scrollTop = 80;
      document.querySelector('.test-form').scrollTop = 120;
    }, origin, fakeKey);
    const cursor = mock.requests.length;
    await pointerClick('#testBtn');
    await until(() => mock.requests.length === cursor + 1, 'actual UI request reaches same-origin mock');
    const held = mock.pending.at(-1), record = held.record;
    assert.ok(record.fakeAuthorization); assert.equal(record.body.stream, false); assert.equal(record.body.model, 'gpt-5.1');
    assert.match(record.body.messages[0].content, /^LOCAL_LAYOUT_REQUEST/);
    assert.equal(await evaluate(() => /\[native code\]/.test(fetch.toString())), true);
    assert.ok(await evaluate(() => !document.querySelector('#stopTestBtn').disabled && document.querySelector('#testBtn').disabled));
    fits(await evaluate(measure, [...actions, ...headings, '#waitingContainer .label', '.waiting-abort-btn']));
    assert.equal(await evaluate(() => document.querySelectorAll('#messageTimeline .assistant').length), 0, 'mock must remain pending until explicit release');
    await pointerClick('#messageTimeline .msg-toggle-btn');
    await pointerClick('#blocksContainer .toggle-btn');
    // Preserve a real reading position in all three neighboring panes, including an expanded request block.
    await evaluate(() => {
      document.querySelector('#blocksColumn').scrollTop = 60;
      document.querySelector('#timelineColumn').scrollTop = 0;
    });
    const before = await positions();
    for (const s of ['.config-body', '.test-form', '#blocksColumn']) assert.ok(before.panes[s][1] > 0, `nonzero pre-completion position: ${s}`);
    await shot(`ordinary-request-waiting-${reducedMotion ? 'reduced' : 'smooth'}-1920x900`);
    held.release();
    await until(() => evaluate(() => !document.querySelector('#testBtn').disabled && document.querySelector('#stopTestBtn').disabled &&
      !document.querySelector('#waitingContainer').children.length && document.querySelector('#messageTimeline').textContent.includes('LAYOUT_LOCAL_COMPLETION')), 'UI renders response and leaves waiting state');
    await until(async () => !(await evaluate(measure, ['#messageTimeline .assistant .title'])).clipped.length, 'completion scroll settles below sticky timeline title');
    // Smooth motion may still be in flight when the title first enters the scrollport.
    await delay(600);
    const after = await positions(); onlyPaneMoved(before, after, '#timelineColumn');
    fits(await evaluate(measure, [...actions, ...headings, '#messageTimeline .assistant .title']));
    assert.equal(await evaluate(() => document.querySelectorAll('#messageTimeline .assistant').length), 1);
    assert.equal(await evaluate(() => document.querySelectorAll('#blocksContainer .code-block').length), 2);
    assert.equal(await evaluate(() => document.querySelectorAll('.error-inline').length), 0);
    assert.equal(await evaluate(fakeKey => document.querySelector('#blocksContainer').textContent.includes(fakeKey), fakeKey), false);
    report.observations.completions ||= [];
    report.observations.completions.push({ reducedMotion, request: record, before, after });
    await shot(`ordinary-request-complete-${reducedMotion ? 'reduced' : 'smooth'}-1920x900`);
    await pointerClick('#clearBtn');
    assert.ok(await evaluate(() => !document.querySelector('#messageTimeline').children.length && !document.querySelector('#blocksContainer').children.length && document.querySelector('#clearBtn').disabled));
    fits(await evaluate(measure, [...actions, ...headings]));
    await send('Emulation.setEmulatedMedia', { features: [] });
  }

  async function foldedErrorsAndFocus() {
    const cursor = mock.requests.length, networkCursor = browser.diagnostics.requests.length;
    await visit(1920, 900);
    await pointerClick('#testBtn');
    await until(() => evaluate(() => !!document.querySelector('.app-modal.open')), 'missing credentials open the existing modal');
    fits(await evaluate(measure, ['#appModalTitle', '#appModalContent', '#appModalOk']));
    assert.match(await evaluate(() => document.querySelector('#appModalContent').textContent), /API URL.*API Key/);
    await pointerClick('#appModalOk');
    await pointerClick('#workspaceEmptySetup');
    assert.equal(await evaluate(() => document.activeElement.id), 'apiUrl');
    await localConnection(); await select('iq_test_1');
    await click('#profileSelect [data-profile="codex"]');
    await fill('profileCustomHeaders', '{invalid');
    await key('Tab', 9);
    await focus('#model');
    // DOM click deliberately leaves focus in the subtree being hidden, unlike a
    // pointer click which would already focus the disclosure before its handler.
    await click('#workspaceSetupToggle');
    await focused('#workspaceSetupToggle');
    await pointerClick('#testBtn');
    assert.match(await evaluate(() => document.querySelector('#errorMessage').textContent), /自定义请求头无效/);
    assert.equal(await evaluate(() => document.querySelector('#profileCustomHeaders').getAttribute('aria-invalid')), 'true');
    fits(await evaluate(measure, [...actions, ...viewControls, '#errorMessage']));
    await shot('folded-custom-header-error-1920x900');
    await view({ setup: true }, true);
    await click('#profileSelect [data-profile="default"]');
    await select('structured');
    await fill('apiKey', '');
    await view({ setup: false }, true);
    await pointerClick('#testBtn');
    await until(() => evaluate(() => !document.querySelector('#testBtn').disabled), 'missing diagnostic credentials validation completes');
    assert.match(await evaluate(() => document.querySelector('#capabilityError').textContent), /API URL.*API Key/);
    fits(await evaluate(measure, [...actions, '#resultsTitle', '#workspaceSetupToggle', '#capabilityTitle', '#capabilityError']));
    assert.equal(mock.requests.length, cursor, 'folded validation must send no model request');
    assert.equal(browser.diagnostics.requests.slice(networkCursor).some(({ url }) => /assets\/(?:data|vendor)\/lmfpd\//.test(url)), false,
      'disclosures and ordinary validation must not load fingerprint assets');
    report.observations.foldedValidation = { missingCredentialsModal: true, invalidHeadersAlert: true, missingDiagnosticCredentials: true,
      requestsSent: mock.requests.length - cursor };

    await view({ setup: true }); await select('iq_test_1');
    await fill('model', 'gpt-5.1');
    await view({ logs: true });
    await key('Tab', 9); // Establish keyboard modality before testing focus return.
    await evaluate(() => document.querySelector('#blocksColumn').focus({ preventScroll: true }));
    await click('#workspaceLogsToggle'); await focused('#workspaceLogsToggle');
    await focus('#workspaceSetupToggle');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(() => evaluate(() => document.activeElement.id === 'apiUrl' && !document.querySelector('#workspaceConfig').hidden), 'disappearing disclosure returns focus to visible fallback setup');
    fits(await evaluate(measure, ['#apiUrl']), false);
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(() => evaluate(() => document.querySelector('#workspaceSetupToggle').checkVisibility()), 'wide disclosures return');
    assert.equal(await evaluate(() => document.querySelector('#workspaceLogsToggle').getAttribute('aria-expanded')), 'false', 'breakpoint reflow retains page-memory choices');
    await view({ setup: false });
    assert.equal(mock.requests.length, cursor);
  }

  async function htmlPreviewAndCopy() {
    await visit(1920, 900); await view({ setup: true }); await localConnection(); await select('iq_test_3');
    await evaluate(() => {
      window.layoutPreviewLoaded = false;
      document.querySelector('#htmlPreviewContainer').addEventListener('load', event => {
        if (event.target.matches('iframe')) window.layoutPreviewLoaded = true;
      }, true);
    });
    await fill('userInput', 'LOCAL_LAYOUT_PREVIEW');
    await evaluate(() => { document.querySelector('#streamToggle').checked = false; });
    await view({ setup: false });
    const cursor = mock.requests.length; await pointerClick('#testBtn');
    await until(() => mock.requests.length === cursor + 1, 'actual local HTML response request');
    mock.pending.at(-1).release();
    await until(() => evaluate(() => !document.querySelector('#testBtn').disabled && !!document.querySelector('#htmlPreviewContainer iframe') && window.layoutPreviewLoaded), 'native HTML answer loads its preview frame');
    assert.equal(mock.requests.at(-1).kind, 'preview');
    // Nonstream completion retains the old card alignment; reading the preview is
    // a normal user scroll to the primary timeline's beginning.
    await delay(600); // Let the retained smooth nonstream completion alignment finish first.
    await evaluate(() => document.querySelector('#timelineColumn').focus({ preventScroll: true })); await key('Home', 36);
    await until(() => evaluate(() => document.querySelector('#timelineColumn').scrollTop === 0), 'keyboard reaches primary preview');
    fits(await evaluate(measure, [...actions, ...viewControls, '#htmlPreviewSection', '#htmlPreviewOpen', '#htmlPreviewToggle']));
    const preview = await evaluate(() => {
      const frame = document.querySelector('#htmlPreviewContainer iframe'); window.layoutPreviewNode = frame;
      return { inPrimary: !!frame.closest('#timelineColumn'), sandbox: frame.getAttribute('sandbox'), title: frame.title,
        srcdoc: frame.srcdoc, logsHidden: document.querySelector('#blocksColumn').hidden };
    });
    assert.ok(preview.inPrimary && preview.logsHidden); assert.equal(preview.sandbox, 'allow-scripts');
    assert.equal(preview.title, 'HTML 预览'); assert.match(preview.srcdoc, /LOCAL_LAYOUT_PREVIEW/);
    await pointerClick('#htmlPreviewToggle');
    assert.equal(await evaluate(() => document.querySelector('#htmlPreviewContainer').checkVisibility()), false);
    await pointerClick('#htmlPreviewToggle');
    assert.ok(await evaluate(() => document.querySelector('#htmlPreviewContainer iframe') === window.layoutPreviewNode));
    await view({ logs: true });
    await pointerClick('#blocksContainer .toggle-btn');
    const copied = await evaluate(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(navigator.clipboard, 'writeText');
      const values = [];
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => values.push(text) });
      try { document.querySelector('#blocksContainer .copy-btn').click(); await Promise.resolve(); }
      finally { if (descriptor) Object.defineProperty(navigator.clipboard, 'writeText', descriptor); else delete navigator.clipboard.writeText; }
      return values;
    });
    assert.equal(copied.length, 1); assert.match(copied[0], /Bearer \*\*\*/); assert.ok(!copied[0].includes(fakeKey));
    await view({ logs: false });
    fits(await evaluate(measure, [...actions, ...viewControls, '#htmlPreviewSection']));
    assert.ok(await evaluate(() => document.querySelector('#htmlPreviewContainer iframe') === window.layoutPreviewNode));
    await shot('html-preview-primary-1920x900');
    await pointerClick('#clearBtn');
    assert.ok(await evaluate(() => document.querySelector('#clearBtn').disabled && !document.querySelector('#messageTimeline').children.length &&
      !document.querySelector('#blocksContainer').children.length && !document.querySelector('#htmlPreviewContainer').children.length &&
      !document.querySelector('#htmlPreviewSection').checkVisibility()));
    fits(await evaluate(measure, [...actions, ...viewControls, '#workspaceEmptySetup']));
    assert.equal(mock.requests.length, cursor + 1);
    report.observations.htmlPreview = { nativeResponse: true, primary: preview.inPrimary, samePreviewNodeAcrossDisclosures: true,
      sandbox: preview.sandbox, maskedCopy: true, clearRemovesPreviewAndResults: true };
  }

  async function localDiagnosticResults() {
    await visit(1920, 900); await view({ setup: true }); await localConnection();
    const records = [];
    mock.diagnostic = {};
    try {
      for (const scenario of ['structured', 'needle', 'capacity']) {
        await view({ setup: true });
        await pointerClick(`#testType [data-scenario="${scenario}"]`);
        await fill('needleTokens', '2048'); await fill('needleDepth', '50');
        await fill('capacityStart', '8192'); await fill('capacityResolution', '1024');
        await view({ setup: false });
        const cursor = mock.requests.length;
        await pointerClick('#testBtn');
        await until(() => evaluate(() => !document.querySelector('#testBtn').disabled && !!document.querySelector('#capabilityResults .is-pass')), `native ${scenario} produces a successful verdict`);
        const sent = mock.requests.slice(cursor);
        assert.ok(sent.length > 0 && sent.length <= 10, 'native diagnostic must use a bounded number of local requests');
        assert.ok(sent.every(record => record.kind === scenario && record.fakeAuthorization && record.body.stream === false));
        if (scenario !== 'capacity') assert.equal(sent.length, 1);
        else {
          assert.ok(sent.some(record => record.status === 200) && sent.some(record => record.status === 400), 'capacity UI must show a real accepted/rejected bracket');
          assert.equal(await evaluate(() => document.querySelectorAll('#capacityAttempts tr').length), sent.length);
        }
        const visible = await evaluate(measure, [...actions, '#resultsTitle', '#workspaceSetupToggle', '#capabilityTitle', '.capability-result-head', '.capability-result-note']);
        fits(visible);
        assert.equal(await evaluate(() => document.querySelector('#workspaceLogsToggle').checkVisibility()), false);
        assert.equal(await evaluate(() => document.querySelector('#capabilityPanel').scrollTop), 0, 'native verdict is visible without specialist scrolling');
        const text = await evaluate(() => document.querySelector('#capabilityResults').textContent);
        if (scenario === 'structured') assert.match(text, /Lisbon/);
        if (scenario === 'needle') assert.match(text, /命中/);
        if (scenario === 'capacity') assert.match(text, /已收敛本地估算区间/);
        await evaluate(() => {
          window.layoutDiagnosticResult = document.querySelector('#capabilityResults .capability-result');
          window.layoutDiagnosticText = document.querySelector('#capabilityResults').textContent;
        });
        const requestsBeforeDisclosure = mock.requests.length;
        await view({ setup: true }, true); await view({ setup: false });
        assert.ok(await evaluate(() => document.querySelector('#capabilityResults .capability-result') === window.layoutDiagnosticResult &&
          document.querySelector('#capabilityResults').textContent === window.layoutDiagnosticText));
        assert.equal(mock.requests.length, requestsBeforeDisclosure, 'folding must not rerun a diagnostic');
        fits(await evaluate(measure, [...actions, '#capabilityTitle', '.capability-result-head']));
        await shot(`native-${scenario}-result-priority-1920x900`);
        records.push({ scenario, requests: sent.length, statuses: sent.map(record => record.status), verdict: text, initialGeometry: visible });
      }
      await view({ setup: true }); await pointerClick('#testType [data-scenario="structured"]'); await view({ setup: false });
      mock.diagnostic = { parameterError: true };
      const cursor = mock.requests.length;
      await pointerClick('#testBtn');
      await until(() => evaluate(() => !document.querySelector('#testBtn').disabled && !!document.querySelector('#capabilityResults .is-fail')), 'native diagnostic parameter error renders a failed verdict');
      assert.equal(mock.requests.length, cursor + 1); assert.ok(mock.requests.at(-1).parameterError);
      fits(await evaluate(measure, [...actions, '#resultsTitle', '#workspaceSetupToggle', '#capabilityTitle', '.capability-result-head', '.capability-result-note', '.capability-result-detail summary']));
      await pointerClick('.capability-result-detail summary');
      assert.match(await evaluate(() => document.querySelector('.capability-result-detail pre').textContent), /Local diagnostic parameter is not supported/);
      fits(await evaluate(measure, [...actions, '#capabilityTitle', '.capability-result-detail pre']));
      await shot('folded-diagnostic-parameter-error-1920x900');
      report.observations.nativeDiagnostics = { records, parameterError: { requests: 1, status: mock.requests.at(-1).status, visible: true } };
    } finally { mock.diagnostic = null; }
  }

  async function nativeManualFingerprint() {
    await visit(1920, 900); await view({ setup: true });
    await pointerClick('#testType [data-scenario="fingerprint"]'); await view({ setup: false });
    await manualFingerprint();
    const cursor = mock.requests.length;
    assert.ok(await evaluate(() => window.LMFPD && typeof window.LMFPD.analyzeSharedOutputs === 'function'));
    // A random sequence is correctly rejected as not_model by the real core.
    // Reuse its existing scored conformance case to exercise actual ranking UI.
    const fixtureBytes = await readFile(join(root, 'tests/fixtures/lmfpd-sync/analyze-supported.json'));
    const fixture = JSON.parse(fixtureBytes).cases.find(item => item.expected.decision === 'scored' && item.outputs.length === 3);
    assert.ok(fixture, 'The repository must provide a real scored three-output fixture');
    await evaluate(outputs => {
      document.querySelectorAll('.fingerprint-sample-textarea').forEach((el, i) => {
        el.value = outputs[i].text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }, fixture.outputs);
    await pointerClick('#testBtn');
    await until(() => evaluate(() => !document.querySelector('#testBtn').disabled &&
      document.querySelector('#fingerprintStatus').textContent.includes('评分完成') && !!document.querySelector('#fingerprintResult .fingerprint-prediction')), 'real local reference/core manual scoring returns a ranking');
    assert.equal(mock.requests.length, cursor, 'manual fingerprint must not require a credential or API request');
    const result = await evaluate(() => ({ text: document.querySelector('#fingerprintResult').textContent,
      candidates: document.querySelectorAll('#fingerprintResult .fingerprint-candidate').length,
      prediction: document.querySelector('#fingerprintResult .fingerprint-prediction-name')?.textContent,
      samples: [...document.querySelectorAll('.fingerprint-sample-textarea')].map(el => el.value),
      status: document.querySelector('#fingerprintStatus').textContent, referenceReady: document.querySelector('#fingerprintDataRow').classList.contains('is-ready') }));
    assert.ok(result.referenceReady); assert.match(result.text, /shared-detector-v2/); assert.match(result.text, /3 \/ 3/);
    assert.equal(result.prediction, fixture.expected.prediction_name, 'The real core/reference must return the conformance prediction');
    assert.ok(result.candidates >= 5, 'rankings must come from the actual detector output');
    fits(await evaluate(measure, [...actions, '#resultsTitle', '#workspaceSetupToggle', '#fingerprintTitle',
      '.fingerprint-sample-textarea', '#fingerprintResult .fingerprint-prediction', '#fingerprintResult > .fingerprint-candidates .fingerprint-candidate']));
    const panelTop = await evaluate(() => document.querySelector('#fingerprintPanel').scrollTop);
    assert.equal(panelTop, 0, 'initial prediction and top candidates should be visible without scrolling');
    await shot('fingerprint-native-score-top-1920x900');
    await evaluate(() => {
      window.layoutScoredPrediction = document.querySelector('#fingerprintResult .fingerprint-prediction');
      window.layoutScoredSample = document.querySelector('.fingerprint-sample-textarea');
    });
    await view({ setup: true }, true); await view({ setup: false });
    assert.ok(await evaluate(() => document.querySelector('#fingerprintResult .fingerprint-prediction') === window.layoutScoredPrediction &&
      document.querySelector('.fingerprint-sample-textarea') === window.layoutScoredSample));
    assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.fingerprint-sample-textarea')].map(el => el.value)), result.samples);
    assert.equal(await evaluate(() => document.querySelector('#fingerprintResult').textContent), result.text);
    assert.equal(await evaluate(() => document.querySelector('#fingerprintStatus').textContent), result.status);
    assert.equal(mock.requests.length, cursor);
    await evaluate(() => document.querySelector('#fingerprintPanel').focus({ preventScroll: true })); await key('End', 35);
    const caveat = '.fingerprint-result-section > .fingerprint-caveat';
    await until(async () => !(await evaluate(measure, [caveat, '#fingerprintAttribution'])).clipped.length, 'keyboard reaches complete actual-score caveat and attribution');
    fits(await evaluate(measure, [...actions, '#resultsTitle', '#workspaceSetupToggle', '#fingerprintTitle', caveat, '#fingerprintAttribution']));
    assert.match(await evaluate(selector => document.querySelector(selector).textContent, caveat), /闭集排序/);
    await shot('fingerprint-native-score-caveat-1920x900');
    report.observations.nativeManualFingerprint = { noModelRequests: true, candidates: result.candidates,
      referenceReady: result.referenceReady, status: result.status, sampleAndResultNodesPreserved: true, caveatReachable: true,
      fixture: { name: fixture.name, sha256: hash(fixtureBytes), prediction: result.prediction } };
  }

  async function streamingRequest({ scenario, reasoning, reducedMotion, readerControl = false, multiTurn = false, disclosures = false, resultPriority = false }) {
    const name = `${scenario}-${reasoning ? 'reasoning' : 'content'}-${reducedMotion ? 'reduced' : 'smooth'}${readerControl ? '-reader-control' : ''}${multiTurn ? '-two-turns' : ''}${disclosures ? '-disclosures' : ''}${resultPriority ? '-result-priority' : ''}`;
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }] });
    await visit(1920, 900);
    await comparison();
    await click('#profileSelect [data-profile="codex"]');
    await click('#proxyToggle'); await click('#profileAdvancedDetails summary'); await click('#profileCustomHeadersDetails summary');
    await click('#openaiProtocol [data-protocol="chat_completions"]'); await select(scenario);
    await evaluate((origin, fakeKey) => {
      for (const [id, value] of [['apiUrl', origin], ['apiKey', fakeKey], ['model', 'gpt-5.1']]) {
        const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('#streamToggle').checked = true;
      const input = document.querySelector('#userInput'); input.value = 'LOCAL_LAYOUT_STREAM\n' + '本地消息用于保持请求栏的阅读位置。\n'.repeat(100);
      input.style.height = '1100px';
      document.querySelector('.config-body').scrollTop = 80; document.querySelector('.test-form').scrollTop = 120;
    }, origin, fakeKey);
    const cursor = mock.streams.length;
    await pointerClick('#testBtn');
    await until(() => mock.streams.length === cursor + 1, 'native UI opens gated same-origin SSE');
    let stream = mock.streams.at(-1), record = stream.record, expectedAssistantCards = 1;
    assert.ok(record.fakeAuthorization); assert.equal(record.body.stream, true);
    assert.equal(!!record.body.tools, scenario === 'openai_tools', 'exercise the separate ordinary tools branch');
    fits(await evaluate(measure, [...actions, ...headings, '#waitingContainer .label']));
    assert.equal(await evaluate(() => document.querySelectorAll('#messageTimeline .assistant').length), 0);
    await pointerClick('#blocksContainer .toggle-btn');
    await evaluate(() => { document.querySelector('#blocksColumn').scrollTop = 60; });
    let baseline = await positions();
    for (const s of ['.config-body', '.test-form', '#blocksColumn']) assert.ok(baseline.panes[s][1] > 0, `nonzero streaming neighbor position: ${s}`);
    if (resultPriority) { await view({ setup: false, logs: false }); baseline = await positions(); }
    const observation = { name, scenario, reasoning, reducedMotion, readerControl, multiTurn, disclosures, baseline, stages: [], violations: [] };
    report.observations.streaming ||= []; report.observations.streaming.push(observation);
    const verify = (stage, assertion) => {
      try { assertion(); } catch (error) { observation.violations.push(`${stage}: ${error.message}`); }
    };
    async function checkpoint(stage, selector, marker, before, completed = false, paused = false) {
      await until(() => evaluate((selector, marker) => [...document.querySelectorAll(selector)].at(-1)?.textContent.includes(marker), selector, marker), `native SSE renders ${stage}`);
      // Allow the application's scheduled/smooth scroll to settle without helping it.
      let tail;
      for (const deadline = Date.now() + 800; Date.now() < deadline; await delay(40)) {
        tail = await evaluate(measureStreamTail, selector, marker);
        if (tail.visible !== paused) break;
      }
      await delay(120);
      tail = await evaluate(measureStreamTail, selector, marker);
      const scrolls = await positions();
      const state = await evaluate(() => ({ running: document.querySelector('#testBtn').disabled,
        stopEnabled: !document.querySelector('#stopTestBtn').disabled, waiting: !!document.querySelector('#waitingContainer').children.length,
        assistantCards: document.querySelectorAll('#messageTimeline .assistant').length,
        errorCards: document.querySelectorAll('#messageTimeline .error-inline').length }));
      const shownHeadings = await evaluate(() => document.querySelector('#blocksColumn').hidden ? ['#timelineTitle'] : ['#timelineTitle', '#blocksTitle']);
      const controls = await evaluate(measure, [...actions, ...viewControls, ...shownHeadings, ...(completed ? [] : ['#waitingContainer .label'])]);
      observation.stages.push({ stage, marker, tail, scrolls, state, controls, paused, eofReleased: !!record.released });
      verify(stage, () => {
        assert.equal(state.running, !completed); assert.equal(state.stopEnabled, !completed); assert.equal(state.waiting, !completed);
        assert.equal(!!record.released, completed, 'EOF is controlled by the test, never a timeout');
        assert.equal(state.assistantCards, expectedAssistantCards, 'each streamed turn must reuse one assistant card'); assert.equal(state.errorCards, 0);
        assert.deepEqual(scrolls.page, baseline.page);
        for (const s of scrollOwners.filter(s => s !== '#timelineColumn')) assert.deepEqual(scrolls.panes[s], baseline.panes[s], `streaming moved ${s}`);
        fits(controls);
      });
      verify(stage, () => assert.equal(tail.visible, !paused, `latest ${marker} visibility disagrees with reader position: ${JSON.stringify(tail)}`));
      if (paused) verify(stage, () => assert.deepEqual(scrolls.panes['#timelineColumn'], before.panes['#timelineColumn'], 'new chunks/EOF moved the paused reader'));
      else if (!completed) verify(stage, () => assert.ok(scrolls.panes['#timelineColumn'][1] > before.panes['#timelineColumn'][1] + 1,
        `timeline did not follow growing ${stage}: ${before.panes['#timelineColumn'][1]} -> ${scrolls.panes['#timelineColumn'][1]}`));
      await shot(`streaming-${name}-${stage}`);
      return scrolls;
    }
    // Each marker ends a distinct batch. No next batch or EOF is released until
    // the prior batch has been rendered and measured while the native UI is busy.
    const selector = reasoning ? '#messageTimeline .assistant .reasoning-content' : '#messageTimeline .assistant .answer-content';
    const field = reasoning ? 'reasoning_content' : 'content';
    const batch = (lines, marker) => '本地流式输出，用于验证消息栏跟随。\n'.repeat(lines) + marker;
    async function pauseReader() {
      const start = await positions();
      await wheel('#timelineColumn', -360);
      await until(() => evaluate(top => {
        const p = document.querySelector('#timelineColumn');
        return p.scrollTop < top - 200 && p.scrollHeight - p.clientHeight - p.scrollTop > 200;
      }, start.panes['#timelineColumn'][1]), 'real wheel pauses timeline follow');
      await delay(180);
      const paused = await positions(); onlyPaneMoved(start, paused, '#timelineColumn');
      return paused;
    }
    async function disclosureRoundTrip(paused, marker) {
      const before = await positions(), count = mock.requests.length;
      await evaluate(() => {
        window.layoutDisclosureNodes = ['#workspaceConfig', '#workspaceTestControls', '#blocksContainer .code-block', '#messageTimeline .assistant']
          .map(s => document.querySelector(s));
        window.layoutDisclosureState = { values: ['apiUrl', 'apiKey', 'model', 'userInput'].map(id => document.getElementById(id).value),
          scenario: APITestBridge.getRequestContext().scenario, rawClass: document.querySelector('#blocksContainer .code-block').className };
        window.layoutScenarioChanges = 0;
        window.addEventListener('apitest:scenario-change', () => { window.layoutScenarioChanges++; }, { once: true });
      });
      const disclosureEvidence = { paused, before, steps: [] };
      observation.disclosureTransitions ||= []; observation.disclosureTransitions.push(disclosureEvidence);
      const recordStep = async label => {
        disclosureEvidence.steps.push({ label, scrolls: await positions(), raw: await evaluate(() => {
          const p = document.querySelector('#blocksColumn'); return { width: p.clientWidth, height: p.clientHeight, content: p.scrollHeight, hidden: p.hidden };
        }) });
      };
      await view({ setup: false }, true); await recordStep('setup folded');
      await view({ logs: false }, true); await recordStep('logs folded');
      assert.ok(await evaluate(() => document.querySelector('#workspaceConfig').hidden && document.querySelector('#workspaceTestControls').hidden && document.querySelector('#blocksColumn').hidden));
      const folded = await positions();
      if (paused) assert.deepEqual(folded.panes['#timelineColumn'], before.panes['#timelineColumn'], 'folding forced a paused timeline to move');
      else assert.ok((await evaluate(measureStreamTail, selector, marker)).visible, 'folding must retain the followed tail');
      const foldedMarker = paused ? 'VIEW_PAUSED_END' : 'VIEW_FOLDED_END';
      stream.emit({ content: '\n' + batch(35, foldedMarker) });
      await until(() => evaluate(marker => document.querySelector('#messageTimeline .assistant .answer-content').textContent.includes(marker), foldedMarker), 'SSE grows with both auxiliary panes folded');
      await delay(150);
      if (paused) assert.deepEqual((await positions()).panes['#timelineColumn'], folded.panes['#timelineColumn'], 'folded chunk moved the paused reader');
      else assert.ok((await evaluate(measureStreamTail, selector, foldedMarker)).visible, 'default result view follows streamed output');
      await shot(`streaming-${name}-${paused ? 'paused' : 'following'}-folded`);
      await view({ logs: true }); await recordStep('logs restored at full result width');
      await view({ setup: true }); await recordStep('setup restored');
      const restored = await positions();
      Object.assign(disclosureEvidence, { folded, restored });
      for (const s of ['.config-body', '.test-form', '#blocksColumn']) verify('disclosure round trip', () => assert.deepEqual(restored.panes[s], before.panes[s], `disclosure lost ${s} position`));
      if (paused) assert.deepEqual(restored.panes['#timelineColumn'], before.panes['#timelineColumn'], 'restoring comparison forced a paused timeline to move');
      else assert.ok((await evaluate(measureStreamTail, selector, foldedMarker)).visible, 'restoring comparison must retain the followed tail');
      assert.ok(await evaluate(() => {
        const nodes = ['#workspaceConfig', '#workspaceTestControls', '#blocksContainer .code-block', '#messageTimeline .assistant'].map(s => document.querySelector(s));
        const state = window.layoutDisclosureState;
        return nodes.every((node, i) => node === window.layoutDisclosureNodes[i]) &&
          JSON.stringify(state.values) === JSON.stringify(['apiUrl', 'apiKey', 'model', 'userInput'].map(id => document.getElementById(id).value)) &&
          state.scenario === APITestBridge.getRequestContext().scenario && state.rawClass === nodes[2].className &&
          window.layoutScenarioChanges === 0 && document.querySelector('#testBtn').disabled && !document.querySelector('#stopTestBtn').disabled;
      }), 'disclosures must preserve input/result identities, values, raw expansion and the running controller');
      assert.equal(mock.requests.length, count); assert.equal(!!record.aborted, false); assert.equal(!!record.released, false);
      fits(await evaluate(measure, [...actions, ...viewControls, ...headings]));
      baseline = restored;
    }
    try {
      stream.emit({ [field]: batch(70, 'STREAM_FIRST_END') });
      let before = await checkpoint('first', selector, 'STREAM_FIRST_END', baseline);
      assert.ok(observation.stages.at(-1).tail.timeline.content > observation.stages.at(-1).tail.timeline.height + 500, 'stream fixture must cross the timeline viewport');
      if (disclosures) { await disclosureRoundTrip(false, 'STREAM_FIRST_END'); before = await positions(); }
      stream.emit({ [field]: '\n' + batch(45, 'STREAM_LATER_END') });
      before = await checkpoint('later', selector, 'STREAM_LATER_END', before);
      if (reasoning) {
        stream.emit({ content: batch(70, 'STREAM_ANSWER_END') });
        before = await checkpoint('answer', '#messageTimeline .assistant .answer-content', 'STREAM_ANSWER_END', before);
      }
      let finalMarker = reasoning ? 'STREAM_ANSWER_END' : 'STREAM_LATER_END';
      if (readerControl) {
        const paused = await pauseReader();
        if (disclosures) await disclosureRoundTrip(true, 'STREAM_LATER_END');
        stream.emit({ content: '\n' + batch(30, 'STREAM_PAUSED_END') });
        await checkpoint('paused', selector, 'STREAM_PAUSED_END', paused, false, true);
        await evaluate(() => document.querySelector('#timelineColumn').focus({ preventScroll: true }));
        await key('End', 35);
        await until(() => evaluate(() => {
          const p = document.querySelector('#timelineColumn'); return p.scrollHeight - p.clientHeight - p.scrollTop <= 1;
        }), 'keyboard End returns the reader to the timeline bottom');
        await focused('#timelineColumn'); before = await positions();
        stream.emit({ content: '\n' + batch(30, 'STREAM_RESUMED_END') });
        await checkpoint('resumed', selector, 'STREAM_RESUMED_END', before);
        before = await pauseReader();
        finalMarker = 'STREAM_PAUSED_FINAL_END';
        stream.emit({ content: '\n' + batch(30, finalMarker) });
        await checkpoint('paused-final', selector, finalMarker, before, false, true);
      }
      if (multiTurn) {
        stream.emit({ tool_calls: [{ index: 0, id: 'layout-convert', type: 'function',
          function: { name: 'convert_base', arguments: '{"number":"f","from_base":16,"to_base":10}' } }] });
        stream.release();
        await until(() => mock.streams.length === cursor + 2, 'native tool execution starts a second SSE request');
        stream = mock.streams.at(-1); record = stream.record; expectedAssistantCards = 2;
        const toolOutput = record.body.messages.find(message => message.role === 'tool');
        assert.equal(toolOutput.tool_call_id, 'layout-convert'); assert.deepEqual(JSON.parse(toolOutput.content), { result: '15' });
        assert.equal(await evaluate(() => document.querySelectorAll('#messageTimeline .tool').length), 1);
        before = await positions();
        stream.emit({ content: batch(70, 'STREAM_TURN2_FIRST_END') });
        before = await checkpoint('turn2-first', selector, 'STREAM_TURN2_FIRST_END', before);
        finalMarker = 'STREAM_TURN2_LATER_END';
        stream.emit({ content: '\n' + batch(45, finalMarker) });
        before = await checkpoint('turn2-later', selector, finalMarker, before);
      }
      stream.release();
      await until(() => evaluate(() => !document.querySelector('#testBtn').disabled && !document.querySelector('#waitingContainer').children.length), 'SSE EOF completes the UI');
      await checkpoint('complete', '#messageTimeline .assistant .answer-content', finalMarker, before, true, readerControl);
      assert.equal(mock.streams.length, cursor + (multiTurn ? 2 : 1), 'only the explicit tool call may create a second round');
      assert.equal(observation.violations.length, 0, observation.violations.join('\n'));
    } finally {
      stream.release();
      await send('Emulation.setEmulatedMedia', { features: [] });
    }
  }

  async function narrowStreaming(reasoning) {
    await visit(768, 1024); await select('iq_test_1');
    await evaluate((origin, fakeKey) => {
      for (const [id, value] of [['apiUrl', origin], ['apiKey', fakeKey], ['model', 'gpt-5.1']]) {
        const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('#streamToggle').checked = true;
    }, origin, fakeKey);
    const cursor = mock.streams.length; await click('#testBtn');
    await until(() => mock.streams.length === cursor + 1, 'narrow UI opens local SSE');
    const stream = mock.streams.at(-1), selector = `#messageTimeline .assistant .${reasoning ? 'reasoning-content' : 'answer-content'}`;
    const field = reasoning ? 'reasoning_content' : 'content';
    const observation = { reasoning, viewport: [768, 1024], stages: [] };
    report.observations.narrowStreaming ||= []; report.observations.narrowStreaming.push(observation);
    try {
      for (let i = 1; i <= 2; i++) {
        const before = await positions(), marker = `NARROW_STREAM_END_${i}`;
        stream.emit({ [field]: '窄屏本地流式输出\n'.repeat(65) + marker + '\n' });
        await until(() => evaluate((selector, marker) => document.querySelector(selector)?.textContent.includes(marker), selector, marker), `narrow chunk ${i} rendered`);
        await delay(120);
        const after = await positions(), tail = await evaluate(measureStreamTail, selector, marker);
        assert.deepEqual(after, before, 'narrow chunks must scroll only the capped pre, never the page or a workspace pane');
        assert.ok(tail.pre.content > tail.pre.height + 500, 'narrow fixture must overflow its capped pre');
        assert.ok(tail.pre.top > 0 && tail.pre.content - tail.pre.height - tail.pre.top <= 1, 'narrow pre must follow its streamed tail');
        assert.equal(tail.pre.overflowY, 'auto');
        assert.ok(await evaluate(() => document.querySelector('#testBtn').disabled && !document.querySelector('#stopTestBtn').disabled));
        assert.equal(!!stream.record.released, false);
        if (i === 2) assert.ok(tail.visible, 'narrow latest marker must remain visible after the reader reveals the pre');
        observation.stages.push({ marker, before, after, tail, eofReleased: !!stream.record.released });
        if (i === 1) {
          // A narrow page requires ordinary page scrolling to reach results. The
          // second chunk must preserve that chosen position while its pre follows.
          await evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center', behavior: 'instant' }), selector);
          fits(await evaluate(measure, [selector]), false);
        }
      }
      await shot(`streaming-narrow-${reasoning ? 'reasoning' : 'content'}-768x1024`);
      stream.release();
      await until(() => evaluate(() => !document.querySelector('#testBtn').disabled && !document.querySelector('#waitingContainer').children.length), 'narrow stream completes');
      assert.equal(await evaluate(() => document.querySelectorAll('#messageTimeline .assistant').length), 1);
      if (reasoning) assert.equal(await evaluate(() => document.querySelector('.reasoning-section').classList.contains('collapsed')), true);
    } finally { stream.release(); }
  }

  async function manualFingerprint() {
    await click('#fingerprintMode [data-mode="manual"]');
    await until(() => evaluate(() => document.querySelectorAll('.fingerprint-sample-textarea').length === 3), 'three local manual samples');
    // Core/challenges arrive before the local reference metadata, which can change row height.
    await until(() => evaluate(() => document.querySelector('#fingerprintDataRow').classList.contains('is-ready')), 'local reference metadata settled');
    assert.equal(await evaluate(() => document.querySelector('#testBtn').textContent), '评分');
  }

  async function fingerprintFixture() {
    await evaluate(() => {
      document.querySelectorAll('.fingerprint-sample-textarea').forEach((el, i) => {
        el.value = `本地样本 ${i + 1}：` + '123 45 67 89 '.repeat(30); el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const list = document.createElement('ol'); list.className = 'fingerprint-candidates';
      for (let i = 1; i <= 40; i++) {
        const row = document.createElement('li'); row.className = 'fingerprint-candidate';
        for (const [cls, text] of [['rank', String(i)], ['name', `本地布局候选 ${i}`], ['prob', `${(100 / i).toFixed(1)}%`]]) {
          const span = document.createElement('span'); span.className = `fingerprint-candidate-${cls}`; span.textContent = text; row.append(span);
        }
        list.append(row);
      }
      document.querySelector('#fingerprintResult').replaceChildren(list);
    });
  }

  async function specialists(left, right, stress) {
    for (const [id, panel, title, fields] of [
      ['capacity', '#capabilityPanel', '#capabilityTitle', ['#capacityStart', '#capacityResolution', '#capacityBudgetHint']],
      ['fingerprint', '#fingerprintPanel', '#fingerprintTitle', ['#fingerprintMode button', '#fingerprintDataRow']],
    ]) {
      await select(id);
      if (id === 'fingerprint') {
        await manualFingerprint();
      }
      const m = await evaluate(measure, [...actions, title, ...fields, panel]); fits(m);
      const [x,,w] = m.boxes[panel];
      assert.ok(Math.abs(x - left) < 20 && Math.abs(x + w - right) < 20, `specialist must replace both columns: ${m.boxes[panel]}`);
      assert.equal(await evaluate(() => [document.querySelector('.split-columns'), ...document.querySelectorAll('#capabilityPanel,#fingerprintPanel')]
        .filter(el => el.checkVisibility()).length), 1);
      if (stress && id === 'capacity') {
        await evaluate(() => {
          const tbody = document.querySelector('#capacityAttempts'); document.querySelector('#capacitySection').hidden = false;
          for (let i = 1; i <= 40; i++) for (const [j, text] of [i, i * 1024, '示例', '本地布局检查'].entries()) {
            if (!j) tbody.insertRow(); tbody.rows[i - 1].insertCell().textContent = text;
          }
          document.querySelector('#capabilityStatus').textContent = '本地示例 · 容量搜索过程';
          window.APITestBridge.setScenarioRunState('capacity', { running: true });
        });
        assert.ok(await evaluate(() => !document.querySelector('#stopTestBtn').disabled));
        fits(await evaluate(measure, [...actions, title])); await shot('capacity-populated-1920x900');
        await reachEnd(panel, '#capacityAttempts tr:last-child td:last-child', 'keyboard', [title]);
      } else if (stress && id === 'fingerprint') {
        await fingerprintFixture();
        fits(await evaluate(measure, [...actions, title]));
        await shot('fingerprint-manual-populated-1920x900');
        report.observations.fingerprintRanking = await reachEnd(panel, '.fingerprint-candidate:last-child', 'keyboard', [title]);
        await shot('fingerprint-ranking-end-1920x900');
        await evaluate(() => { document.querySelector('#fingerprintPanel').scrollTop = 0; });
        await reachEnd(panel, '.fingerprint-candidate:last-child', 'wheel', [title]);
      }
    }
  }

  async function wide(width, height) {
    const networkCursor = browser.diagnostics.requests.length;
    await visit(width, height);
    if (!revision) {
      const defaults = await evaluate(measure, [...actions, ...viewControls, '#timelineTitle', '#workspaceEmptySetup']);
      fits(defaults); assert.deepEqual(defaults.viewport, [width, height]);
      assert.ok(await evaluate(() => ['#workspaceConfig', '#workspaceTestControls', '#blocksColumn'].every(s => document.querySelector(s).hidden)));
      assert.equal(await evaluate(() => document.querySelector('#workspaceSetupToggle').getAttribute('aria-controls')), 'workspaceConfig workspaceTestControls');
      assert.equal(await evaluate(() => document.querySelector('#workspaceLogsToggle').getAttribute('aria-controls')), 'blocksColumn');
      assert.equal(mock.requests.length, 0);
      assert.equal(browser.diagnostics.requests.slice(networkCursor).some(({ url }) => /assets\/(?:data|vendor)\/lmfpd\//.test(url)), false, 'layout must not activate reference/core data');
      await shot(`result-priority-default-${width}x${height}`);
      if (width === 1920) {
        await evaluate(prose => {
          const user = document.createElement('div'); user.className = 'card message user collapsed'; user.id = 'commonUser';
          const userTitle = document.createElement('div'); userTitle.className = 'title'; userTitle.textContent = 'user · 用户消息'; user.append(userTitle);
          const answer = document.createElement('div'); answer.className = 'card message assistant'; answer.id = 'commonAnswer';
          const title = document.createElement('div'); title.className = 'title'; title.textContent = 'assistant · 回答';
          const pre = document.createElement('pre'); pre.className = 'answer-content'; pre.textContent = prose; answer.append(title, pre);
          document.querySelector('#messageTimeline').append(user, answer);
        }, representativeAnswer);
        const metrics = await evaluate(prose => {
          const pre = document.querySelector('#commonAnswer pre'), css = getComputedStyle(pre), range = document.createRange();
          range.selectNodeContents(pre);
          const boxes = [...range.getClientRects()];
          const first = document.createRange(), last = document.createRange();
          first.setStart(pre.firstChild, 0); first.setEnd(pre.firstChild, 1);
          last.setStart(pre.firstChild, pre.firstChild.length - 1); last.setEnd(pre.firstChild, pre.firstChild.length);
          const box = r => [r.x, r.y, r.width, r.height];
          return { exact: pre.textContent === prose, lines: new Set(boxes.filter(r => r.height > 0 && r.width > 0).map(r => Math.round(r.top))).size,
            fontSize: css.fontSize, lineHeight: css.lineHeight, maxHeight: css.maxHeight, overflowY: css.overflowY,
            innerOverflow: pre.scrollHeight - pre.clientHeight, primaryWidth: document.querySelector('#timelineColumn').clientWidth,
            first: box(first.getBoundingClientRect()), last: box(last.getBoundingClientRect()),
            scrolls: [document.querySelector('#timelineColumn').scrollTop, document.querySelector('#timelineColumn').scrollHeight, document.querySelector('#timelineColumn').clientHeight] };
        }, representativeAnswer);
        assert.ok(metrics.exact); assert.ok(metrics.lines >= 20 && metrics.lines <= 30, `natural answer lines: ${metrics.lines}`);
        assert.equal(metrics.fontSize, '13px'); assert.equal(metrics.lineHeight, '20.8px'); assert.equal(metrics.maxHeight, 'none');
        assert.equal(metrics.overflowY, 'visible'); assert.equal(metrics.innerOverflow, 0); assert.equal(metrics.scrolls[0], 0);
        assert.ok(metrics.scrolls[1] <= metrics.scrolls[2] + 1, 'common complete result must fit without a timeline scrollbar');
        fits(await evaluate(measure, [...actions, ...viewControls, '#timelineTitle', '#commonUser', '#commonAnswer', '#commonAnswer pre']));
        const tail = await evaluate(measureStreamTail, '#commonAnswer pre', representativeAnswer.slice(-8)); assert.ok(tail.visible);
        report.observations[`representative-${width}x${height}`] = { proseHash: hash(representativeAnswer), ...metrics, tail };
        await shot(`complete-answer-${width}x${height}`);
      }
      // The previous every-field/equal-log checks remain, now explicitly in the
      // user-selected comparison state instead of claiming it is the default.
      await comparison();
    }
    const m = await evaluate(measure, [...controls, ...actions, '#userInput', '#thinkingToggleLabel', '#profileTransportHint', ...headings, ...tracks]);
    report.observations[`comparison-${width}x${height}`] = { ...m, scrolls: await positions() };
    // Save baseline evidence even when HEAD fails the first-screen assertion below.
    await shot(`ordinary-default-${width}x${height}`);
    console.log(`${width}x${height} overflow=${m.overflow} panes(x,y,w,h)=${JSON.stringify(tracks.map(s => m.boxes[s]))}`);
    assert.deepEqual(m.viewport, [width,height]); fits(m);
    const [config, test, timeline, blocks] = tracks.map(s => m.boxes[s]);
    for (const [a,b] of [[config,test], [test,timeline], [timeline,blocks]]) assert.ok(a[0] + a[2] <= b[0] + 1, `panes not side by side: ${a}; ${b}`);
    assert.ok(Math.min(timeline[3], blocks[3]) > height / 2, 'insufficient result reading height');
    if (!revision && width === 1920) {
      const common = report.observations[`representative-${width}x${height}`]; common.comparisonWidth = timeline[2];
      assert.ok(common.primaryWidth > timeline[2] * 3, 'folding auxiliary content must materially widen the result');
      await evaluate(() => document.querySelector('#messageTimeline').replaceChildren());
    }
    const stress = width === 1920 && height === 900;
    await specialists(timeline[0], blocks[0] + blocks[2], stress);
  }

  async function fallback(width, height) {
    await visit(width, height);
    const m = await evaluate(measure, tracks);
    assert.deepEqual(m.viewport, [width,height]); assert.ok(m.overflow[0] <= 1);
    const [config,test,timeline,blocks] = tracks.map(s => m.boxes[s]);
    assert.ok(config[1] + config[3] <= test[1] + 1 && test[1] + test[3] <= timeline[1] + 1, 'fallback reading order');
    assert.ok(width <= 900 ? timeline[1] + timeline[3] <= blocks[1] + 1 : timeline[0] + timeline[2] <= blocks[0] + 1);
    assert.ok(await evaluate(() => !document.querySelector('#workspaceConfig').hidden && !document.querySelector('#workspaceTestControls').hidden && !document.querySelector('#blocksColumn').hidden && !document.querySelector('#workspaceSetupToggle').checkVisibility()));
    await evaluate(() => {
      const lines = document.createElement('pre'); lines.textContent = '本地示例\n'.repeat(100); document.querySelector('#messageTimeline').append(lines);
      document.querySelector('#userInput').focus();
    });
    await key('Tab', 9);
    await focused('#testBtn', '#testBtn', false);
    await evaluate(() => window.scrollTo({ top: document.scrollingElement.scrollHeight, behavior: 'instant' }));
    assert.ok(await evaluate(() => scrollY > 0), 'fallback must allow document scrolling');
    const ordinary = await positions();
    const specialistEvidence = [];
    for (const id of ['structured', 'needle', 'capacity', 'fingerprint']) {
      await select(id);
      if (id === 'fingerprint') await manualFingerprint();
      const target = id === 'fingerprint' ? '.fingerprint-sample:last-child .fingerprint-sample-textarea'
        : id === 'capacity' ? '#capacityResolution' : id === 'needle' ? '#needleDepth' : '#capabilityPanel';
      if (id === 'fingerprint') {
        // Native textarea focus can reveal only the caret. Exercise document keyboard
        // scrolling first, then Tab from the final sample's own prompt to its textarea.
        await focus('#testBtn'); await key('End', 35);
        await until(() => evaluate(() => scrollY + innerHeight >= document.scrollingElement.scrollHeight - 1), 'keyboard reaches final sample on fallback page');
        await focus('.fingerprint-sample:last-child .fingerprint-sample-prompt summary');
        await key('Tab', 9);
      } else await focus(target);
      // A whole section can exceed a short viewport; its schema is the reading target.
      await focused(target, target, false, id === 'structured' ? '#structuredSchemaSummary' : target);
      assert.equal(await evaluate(() => document.querySelector('.split-columns').checkVisibility()), false);
      assert.equal(await evaluate(() => getComputedStyle(document.scrollingElement).overflowY), 'visible', 'fallback releases document scrolling');
      if (id === 'fingerprint') {
        const beforeWheel = await evaluate(() => scrollY);
        const pointer = await evaluate(() => {
          const panel = document.querySelector('#fingerprintPanel'), r = panel.getBoundingClientRect(), css = getComputedStyle(panel);
          const x = r.left + 6, y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
          return { x, y, clientHeight: panel.clientHeight, scrollHeight: panel.scrollHeight, overflowY: css.overflowY,
            overscrollBehaviorY: css.overscrollBehaviorY, hitPanel: panel.contains(document.elementFromPoint(x, y)) };
        });
        assert.ok(pointer.hitPanel, 'fallback wheel must target the visible specialist');
        const { x, y } = pointer;
        report.observations[`fallback-wheel-${width}x${height}`] = { beforeWheel, ...pointer };
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -20000 });
        await until(() => evaluate(y => scrollY < y - 1, beforeWheel), 'wheel over fallback specialist scrolls the document');
        await focus('.fingerprint-sample:last-child .fingerprint-sample-prompt summary'); await key('Tab', 9);
        await focused(target, target, false);
      }
      specialistEvidence.push({ id, target: await evaluate(measure, [id === 'structured' ? '#structuredSchemaSummary' : target]), scrolls: await positions() });
      if (id === 'fingerprint' && [375, 768, 960].includes(width)) await shot(`fingerprint-last-sample-${width}x${height}`);
      // Fallback actions are reached individually through page scrolling; no fixed footer is promised.
      for (const action of ['#testBtn', '#clearBtn']) { await focus(action); await focused(action, action, false); }
      await evaluate(() => document.querySelector('#stopTestBtn').scrollIntoView({ block: 'center', behavior: 'instant' }));
      fits(await evaluate(measure, ['#stopTestBtn']), false);
      assert.ok(await evaluate(() => scrollY > 0), `fallback ${id} must use document scroll`);
    }
    report.observations[`fallback-${width}x${height}`] = { ordinary, specialists: specialistEvidence,
      effectiveCssViewportOnly: width === 960 && height === 450 };
  }

  async function check(name, fn) {
    try {
      await fn(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`);
    } catch (err) {
      report.checks.push({ name, passed: false, error: err.stack || err.message }); console.error(`FAIL ${name}: ${err.message}`);
      report.observations[`failure-${name}`] = { scrolls: await positions(), active: await evaluate(() => document.activeElement?.outerHTML.slice(0, 500)) };
      await shot(`failure-${name.replaceAll(/[^\w-]+/g, '-')}`);
      for (const pending of mock.pending) pending.release();
      await send('Emulation.setEmulatedMedia', { features: [] });
    }
  }
  const viewports = streamingOnly || panelsOnly ? [] : [[wide, [[1920,900], [1920,960], [1920,1080], [1600,900]]]];
  if (!revision && !streamingOnly && !panelsOnly) viewports.push([fallback, [[1599,900], [1920,759], [1440,900], [1024,768], [960,450], [768,1024], [375,812]]]);
  report.viewportCount = panelsOnly ? 1 : streamingOnly ? 2 : viewports.reduce((count, [, sizes]) => count + sizes.length, 0);
  for (const [fn, sizes] of viewports) {
    for (const [w,h] of sizes) await check(`${fn.name} ${w}x${h}`, () => fn(w,h));
  }
  if (fullRun) {
    for (const fn of [configStress, dropdowns, imageStress, ordinaryStress]) await check(fn.name, fn);
    for (const reduced of [false, true]) await check(`ordinary UI completion (${reduced ? 'reduced motion' : 'smooth motion'})`, () => ordinaryRequest(reduced));
  }
  if (fullRun || panelsOnly) for (const fn of [foldedErrorsAndFocus, htmlPreviewAndCopy, localDiagnosticResults, nativeManualFingerprint]) await check(fn.name, fn);
  const streamCases = revision || viewsOnly || panelsOnly ? [] : [
    { scenario: 'iq_test_1', reasoning: false, reducedMotion: false },
    { scenario: 'iq_test_1', reasoning: true, reducedMotion: true },
    { scenario: 'openai_tools', reasoning: false, reducedMotion: false },
    { scenario: 'openai_tools', reasoning: true, reducedMotion: true },
    { scenario: 'iq_test_1', reasoning: false, reducedMotion: false, readerControl: true },
    { scenario: 'openai_tools', reasoning: false, reducedMotion: false, multiTurn: true },
    { scenario: 'iq_test_1', reasoning: false, reducedMotion: false, readerControl: true, disclosures: true },
    { scenario: 'iq_test_1', reasoning: true, reducedMotion: true, resultPriority: true },
  ];
  for (const item of streamCases) await check(`streaming ${item.scenario} ${item.reasoning ? 'reasoning + answer' : 'plain content'} (${item.reducedMotion ? 'reduced' : 'smooth'} motion)${item.readerControl ? ' reader pause/resume' : ''}${item.multiTurn ? ' two tool turns' : ''}${item.disclosures ? ' disclosures' : ''}${item.resultPriority ? ' result priority' : ''}`, () => streamingRequest(item));
  if (!revision && !viewsOnly && !panelsOnly) for (const reasoning of [false, true]) await check(`narrow streaming ${reasoning ? 'reasoning' : 'content'} preserves capped pre follow`, () => narrowStreaming(reasoning));
  await check('stable source, native fetch, zero runtime/mock errors and no unexpected network', async () => {
    report.finalSourceHashes = await sourceHashes();
    assert.deepEqual(report.finalSourceHashes, report.sourceHashes, 'Production source changed during verification');
    assert.deepEqual(browser.diagnostics.runtimeErrors, []); assert.deepEqual(browser.diagnostics.consoleErrors, []);
    assert.deepEqual(mock.errors, []);
    const unexpected = browser.diagnostics.requests.filter(({ url, method }) => {
      if (url.startsWith('data:')) return false;
      if (!url.startsWith(origin + '/')) return true;
      const pathname = new URL(url).pathname;
      return !((method === 'GET' && (pathname === '/index.html' || pathname.startsWith('/assets/'))) ||
        (method === 'POST' && pathname === '/v1/chat/completions'));
    });
    report.unexpectedNetwork = unexpected; assert.deepEqual(unexpected, []);
    const streamCount = streamCases.reduce((count, item) => count + (item.multiTurn ? 2 : 1), revision || viewsOnly || panelsOnly ? 0 : 2);
    const ordinaryCount = mock.requests.filter(record => !record.body.stream && !['structured', 'needle', 'capacity'].includes(record.kind)).length;
    assert.equal(ordinaryCount, fullRun ? 3 : panelsOnly ? 1 : 0, 'two ordinary JSON completions and one actual HTML preview response in a full run');
    const diagnosticCount = mock.requests.filter(record => ['structured', 'needle', 'capacity'].includes(record.kind)).length;
    const plannedDiagnosticCount = report.observations.nativeDiagnostics?.records.reduce((count, item) => count + item.requests, 1) || 0;
    assert.equal(diagnosticCount, fullRun || panelsOnly ? plannedDiagnosticCount : 0, 'all local diagnostic requests are accounted for by their native runs');
    assert.equal(mock.requests.length, ordinaryCount + diagnosticCount + streamCount);
    assert.equal(mock.streams.length, streamCount);
    assert.equal(await evaluate(() => /\[native code\]/.test(fetch.toString())), true);
  });
}

async function main() {
  if (artifacts) await mkdir(artifacts, { recursive: true });
  else artifacts = await mkdtemp('/tmp/opencode/desktop-layout-');
  await using profile = await mkdtempDisposable('/tmp/opencode/apitest-layout-profile-');
  console.log(`Source: ${revision || 'worktree'}; screenshots: ${artifacts || 'disabled'}`);
  const report = { source: revision || 'worktree', streamingOnly, viewsOnly, panelsOnly, sourceHashes: await sourceHashes(), testHash: hash(await readFile(fileURLToPath(import.meta.url))),
    servedConfigHash: hash(configFixture), runtime: { node: process.version }, checks: [], screenshots: [], observations: {},
    limitations: ['960x450 is an effective CSS viewport fallback equivalent to halving 1920x900; actual browser 200% zoom is not measured.',
      'Long stress diagnostics/rankings/dropdowns use DOM fixtures. Separate native diagnostic mocks and manual fingerprint scoring cover actual result rendering; broad protocol coverage remains in the proxy browser suite.',
      'Screenshots are captured as review artifacts; this test asserts geometry and interaction, not visual aesthetics.'] };
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const chrome = spawn(process.env.APITEST_E2E_CHROME || '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--no-first-run',
    '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--remote-debugging-pipe',
    `--user-data-dir=${profile.path}`, 'about:blank'], { stdio: ['ignore','ignore','ignore','pipe','pipe'] });
  try {
    await once(chrome, 'spawn');
    const browser = connect(chrome); await browser.attach();
    report.runtime.chrome = await browser.send('Browser.getVersion');
    await browser.send('Runtime.enable'); await browser.send('Network.enable'); await browser.send('Page.enable');
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "if (window === window.top && /^https?:$/.test(location.protocol)) { localStorage.clear(); localStorage.setItem('httpProxyUrl', ''); }",
    });
    try { await suite(browser, `http://127.0.0.1:${server.address().port}`, report); }
    finally { report.browser = browser.diagnostics; }
  } catch (error) {
    report.checks.push({ name: 'harness execution', passed: false, error: error.stack || error.message });
  } finally {
    if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = once(chrome, 'exit'); chrome.kill(); await exited;
    }
    server.close(); server.closeAllConnections();
    report.mock = mock.requests; report.mockErrors = mock.errors;
    report.counts = { passed: report.checks.filter(c => c.passed).length, failed: report.checks.filter(c => !c.passed).length,
      viewports: report.viewportCount, mockedOrdinaryRequests: mock.requests.length, streamedRequests: mock.streams.length,
      runtimeErrors: report.browser?.runtimeErrors.length || 0,
      consoleErrors: report.browser?.consoleErrors.length || 0, unexpectedNetwork: report.unexpectedNetwork?.length ?? null };
    await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report.counts)); console.log(`Report: ${join(artifacts, 'report.json')}`);
    process.exitCode = report.counts.failed ? 1 : 0;
  }
}
await main();
