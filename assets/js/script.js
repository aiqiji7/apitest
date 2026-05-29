(function () {
  // Utilities
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // Elements
  const apiUrlEl = $('#apiUrl');
  const apiKeyEl = $('#apiKey');
  const modelEl = $('#model');
  const testBtn = $('#testBtn');
  const clearBtn = $('#clearBtn');
  const blocksContainer = $('#blocksContainer');
  const messageTimeline = $('#messageTimeline');
  const errorMessage = $('#errorMessage');
  const vendorTypeWrap = $('#vendorType');
  const testTypeWrap = $('#testType');
  const userInputEl = $('#userInput');
  const manageConfigBtn = $('#manageConfigBtn');
  const configModal = $('#configModal');
  const fetchModelsBtn = $('#fetchModelsBtn');
  const modelDropdown = $('#modelDropdown');
  const closeConfigModalBtn = $('#closeConfigModal');
  const configListEl = $('#configList');
  const saveConfigBtn = $('#saveConfigBtn');
  const saveAsDefaultBtn = $('#saveAsDefaultBtn');
  const cancelEditBtn = $('#cancelEditBtn');
  const configNameEl = $('#configName');
  const configUrlEl = $('#configUrl');
  const configKeyEl = $('#configKey');
  const configModelEl = $('#configModel');
  const configModalTitleEl = $('#configModalTitle');
  const modalFormHeadingEl = $('#modalFormHeading');

  // Image input elements
  const imageInputArea = $('#imageInputArea');
  const imageFileInput = $('#imageFileInput');
  const imageUrlInput = $('#imageUrlInput');
  const imagePreview = $('#imagePreview');
  const previewImg = $('#previewImg');
  const imageInfo = $('#imageInfo');
  const removeImageBtn = $('#removeImageBtn');

  // Image state
  let currentImageData = null; // base64 data URL or external URL string

  // Edit state
  let editingIndex = null;
  // Waiting loader state
  let requestPending = false;
  let waitingEl = null;
  let currentAbortController = null;

  // Abort current request helper
  function abortCurrentRequest() {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    requestPending = false;
    hideWaiting();
    updateClearBtnState();
  }

  // LocalStorage helpers
  function loadConfigs() {
    try { return JSON.parse(localStorage.getItem('apiConfigs') || '[]'); } catch { return []; }
  }
  function saveConfigs(cfgs) { localStorage.setItem('apiConfigs', JSON.stringify(cfgs)); }

  // URL helpers
  function stripTrailingSlash(u) { return (u || '').replace(/\/+$/, ''); }
  function normalizeApiUrl(u) {
    let val = (u || '').trim();
    if (!val) return val;
    // 自动补全协议
    if (!/^https?:\/\//i.test(val)) val = 'https://' + val;
    // 仅去除尾部斜杠，保留完整路径（不截断到 origin，以支持子路径部署）
    return stripTrailingSlash(val);
  }
  function buildEndpoint(base) { return stripTrailingSlash(base) + '/v1/chat/completions'; }
  function buildGeminiEndpoint(base, model, apiKey) {
    const root = stripTrailingSlash(base);
    return `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  }
  function buildAnthropicEndpoint(base) {
    const root = stripTrailingSlash(base);
    return `${root}/v1/messages`;
  }
  function buildResponsesEndpoint(base) {
    const root = stripTrailingSlash(base);
    return `${root}/v1/responses`;
  }

  // System defaults (single source of truth) with optional env override from window.APP_CONFIG
  const ENV_CFG = (typeof window !== 'undefined' && window.APP_CONFIG && typeof window.APP_CONFIG === 'object') ? window.APP_CONFIG : {};
  const SYSTEM_DEFAULTS = {
    apiUrl: ENV_CFG.apiUrl || 'https://api.openai.com',
    apiKey: ENV_CFG.apiKey || '',
    model: ENV_CFG.model || 'gemini-3-flash-preview'
  };

  function displayConfigs() {
    const cfgs = loadConfigs();
    if (cfgs.length === 0) {
      configListEl.innerHTML = '<p class="config-list-empty">暂无保存的配置</p>';
      return;
    }
    configListEl.innerHTML = cfgs.map((c, i) => `
      <div class="config-item" data-index="${i}">
        <div class="config-info">
          <div class="config-name">${escapeHtml(c.name)}${c.isDefault ? ' <span class="badge-default">默认</span>' : ''}</div>
          <div class="config-url">${escapeHtml(c.url)}</div>
        </div>
        <div class="config-actions">
          <button class="icon-btn star-config ${c.isDefault ? 'starred' : ''}" data-star="${i}" aria-label="设为默认" title="设为默认">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill="currentColor"/>
            </svg>
          </button>
          <button class="icon-btn edit-config" data-edit="${i}" aria-label="编辑">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm2.92 2.33H5v-.92l8.06-8.06.92.92L5.92 19.58zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="currentColor"/>
            </svg>
          </button>
          <button class="icon-btn delete-config" data-del="${i}" aria-label="删除">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M9 3a1 1 0 0 0-1 1v1H5.5a1 1 0 1 0 0 2H6v11a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7h.5a1 1 0 1 0 0-2H16V4a1 1 0 0 0-1-1H9zm6 2h-5V4h5v1zm-6 4a1 1 0 1 1 2 0v8a1 1 0 1 1-2 0V9zm5 0a1 1 0 1 1 2 0v8a1 1 0 1 1-2 0V9z"/>
            </svg>
          </button>
        </div>
      </div>
    `).join('');
  }

  // Escape HTML
  function escapeHtml(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/[&<>"{}]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '{': '&#123;', '}': '&#125;' }[m]));
  }

  // Copy helper
  function attachCopy(btn, targetPre) {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(targetPre.textContent || '');
      const orig = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => btn.textContent = orig, 1500);
    });
  }

  // Waiting inline loader helpers
  function ensureWaitingEl() {
    if (waitingEl) return waitingEl;
    const wrap = document.createElement('div');
    wrap.className = 'waiting-inline';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = '请求中';
    const dots = document.createElement('span');
    dots.className = 'dots';
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('span');
      d.className = 'dot';
      dots.appendChild(d);
    }
    wrap.appendChild(label);
    wrap.appendChild(dots);
    waitingEl = wrap;
    return waitingEl;
  }
  function showWaiting() {
    const el = ensureWaitingEl();
    if (el.parentNode !== messageTimeline) {
      messageTimeline.appendChild(el);
    } else {
      // 重新追加到末尾，确保在最新一条消息下方
      messageTimeline.removeChild(el);
      messageTimeline.appendChild(el);
    }
  }
  function hideWaiting() {
    if (waitingEl && waitingEl.parentNode) { waitingEl.parentNode.removeChild(waitingEl); }
  }

  // Info inline block (tip/warning)
  function addInlineInfo(text) {
    const el = document.createElement('div');
    el.className = 'info-inline';
    el.textContent = String(text || '提示');
    messageTimeline.appendChild(el);
    scrollLatestIntoView();
    updateClearBtnState();
    return el;
  }

  // Success inline block (green tip)
  function addInlineSuccess(text) {
    const el = document.createElement('div');
    el.className = 'success-inline';
    el.textContent = String(text || '成功');
    messageTimeline.appendChild(el);
    scrollLatestIntoView();
    updateClearBtnState();
    return el;
  }

  // Error inline block under latest message
  function addInlineError(text, raw) {
    const el = document.createElement('div');
    el.className = 'error-inline';
    el.textContent = String(text || '发生未知错误');
    // 确保等待动画被移除后再追加错误块
    hideWaiting();
    messageTimeline.appendChild(el);
    // 附带原始内容（JSON/纯文本），不再渲染 HTML 预览
    try {
      const rawText = raw && raw.rawText;
      const ct = (raw && raw.contentType || '').toLowerCase();
      if (rawText) {
        const wrap = document.createElement('div');
        wrap.style.marginTop = '6px';
        // 若为 HTML 返回，补充友好提示
        const isHtml = ct.includes('text/html') || /^\s*<(!doctype|html|head|body)/i.test(rawText);
        let notice = null;
        if (isHtml) {
          notice = document.createElement('div');
          notice.textContent = '检测到返回的是网页，您可能填写了错误的 API URL。';
          notice.style.color = '#b91c1c';
          notice.style.fontWeight = '600';
          notice.style.cursor = 'pointer';
          wrap.appendChild(notice);
        }
        const details = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = '查看原始返回';
        sum.style.cursor = 'pointer';
        const pre = document.createElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.wordBreak = 'break-all';
        // 尝试美化 JSON；否则原样输出
        if (ct.includes('application/json')) {
          try { pre.textContent = JSON.stringify(JSON.parse(rawText), null, 2); }
          catch { pre.textContent = rawText; }
        } else {
          pre.textContent = rawText;
        }
        details.appendChild(sum);
        details.appendChild(pre);
        wrap.appendChild(details);
        // 点击提示或“查看原始返回”文字都可展开/收起
        const toggle = () => { details.open = !details.open; };
        sum.addEventListener('click', (e) => { /* 使用默认展开行为并扩大可点击区域 */ });
        if (notice) {
          notice.addEventListener('click', toggle);
          notice.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
          notice.tabIndex = 0; // 可聚焦
        }
        el.appendChild(wrap);
      }
    } catch { /* 附加原始内容失败时安静降级 */ }
    // 滚动到最新位置（错误块所在）
    scrollLatestIntoView();
    updateClearBtnState();
    return el;
  }

  // Scroll helpers: keep latest message aligned to page top
  function scrollLatestIntoView() {
    const cards = messageTimeline.querySelectorAll('.card.message');
    if (cards.length === 0) return;
    const last = cards[cards.length - 1];
    // 将最新消息滚动到页面顶部位置
    try {
      last.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    } catch { /* 兼容性兜底 */
      const top = window.scrollY + last.getBoundingClientRect().top;
      window.scrollTo({ top: Math.max(top - 8, 0), behavior: 'smooth' });
    }
  }

  // App modal helpers (custom alert/confirm)
  let appModalEl = null;
  function ensureAppModal() {
    if (appModalEl) return appModalEl;
    const overlay = document.createElement('div');
    overlay.className = 'app-modal';
    overlay.innerHTML = `
      <div class="box">
        <div class="title" id="appModalTitle">提示</div>
        <div class="content" id="appModalContent"></div>
        <div class="actions">
          <button class="btn" id="appModalCancel">取消</button>
          <button class="btn btn-primary" id="appModalOk">确定</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    appModalEl = overlay;
    return appModalEl;
  }
  function openAppModal({ title = '提示', content = '', showCancel = false, okText = '确定', cancelText = '取消' } = {}) {
    return new Promise((resolve) => {
      const el = ensureAppModal();
      const titleEl = el.querySelector('#appModalTitle');
      const contentEl = el.querySelector('#appModalContent');
      const okBtn = el.querySelector('#appModalOk');
      const cancelBtn = el.querySelector('#appModalCancel');
      titleEl.textContent = title;
      contentEl.textContent = content;
      okBtn.textContent = okText;
      cancelBtn.textContent = cancelText;
      cancelBtn.style.display = showCancel ? '' : 'none';
      el.classList.add('open');

      const cleanup = () => {
        el.classList.remove('open');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        el.removeEventListener('click', onBackdrop);
        window.removeEventListener('keydown', onKey);
      };
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      // 点击空白：alert 视为确定；confirm 视为取消
      const onBackdrop = (e) => { if (e.target === el) { showCancel ? onCancel() : onOk(); } };
      const onKey = (e) => { if (e.key === 'Escape') { showCancel ? onCancel() : onOk(); } };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      el.addEventListener('click', onBackdrop);
      window.addEventListener('keydown', onKey);
    });
  }
  // Toast helper
  function showToast(msg, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.innerHTML = ''; // 每次只显示一个
    container.appendChild(toast);

    // 触发动画
    requestAnimationFrame(() => {
      container.classList.add('show');
    });

    // 2s后滑出
    setTimeout(() => {
      container.classList.remove('show');
    }, 2000);
  }

  function appAlert(message) {
    return openAppModal({ title: '提示', content: message, showCancel: false, okText: '确定' });
  }

  // Apply config helpers
  function applyConfigToTop(cfg) {
    if (!cfg) return;
    apiUrlEl.value = cfg.url || SYSTEM_DEFAULTS.apiUrl;
    apiKeyEl.value = cfg.key || SYSTEM_DEFAULTS.apiKey;
    modelEl.value = cfg.model || SYSTEM_DEFAULTS.model;
  }
  function applySystemDefaultToTop() {
    apiUrlEl.value = SYSTEM_DEFAULTS.apiUrl;
    apiKeyEl.value = SYSTEM_DEFAULTS.apiKey;
    modelEl.value = SYSTEM_DEFAULTS.model;
  }

  // UI builders
  function addBlock(title, payload, durationMs) {
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    const h = document.createElement('div');
    h.className = 'title';
    // 如果有耗时，在标题后面追加
    if (typeof durationMs === 'number' && durationMs >= 0) {
      h.textContent = `${title} (${formatDuration(durationMs)})`;
    } else {
      h.textContent = title;
    }
    const copy = document.createElement('button');
    copy.className = 'copy-btn';
    copy.textContent = '复制';
    const pre = document.createElement('pre');
    pre.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    wrap.appendChild(h); wrap.appendChild(copy); wrap.appendChild(pre);
    blocksContainer.appendChild(wrap);
    attachCopy(copy, pre);
    updateClearBtnState();
    return wrap;
  }

  // 格式化耗时
  function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function addMessage(role, label, payload) {
    const card = document.createElement('div');
    card.className = `card message ${role}`;
    const title = document.createElement('div');
    title.className = 'title';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const roleEl = document.createElement('span');
    roleEl.className = 'role';
    roleEl.textContent = role;
    const labelEl = document.createElement('span');
    labelEl.className = 'label';
    labelEl.textContent = `· ${label}`;
    meta.appendChild(roleEl); meta.appendChild(labelEl);
    const pre = document.createElement('pre');
    pre.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    title.appendChild(meta);
    card.appendChild(title);
    card.appendChild(pre);
    messageTimeline.appendChild(card);
    // Keep waiting loader under the latest message while pending
    if (requestPending) { showWaiting(); }
    // Scroll page so that the latest message sits at page top
    scrollLatestIntoView();
    updateClearBtnState();
    return card;
  }

  function clearResults() {
    blocksContainer.innerHTML = '';
    messageTimeline.innerHTML = '';
    errorMessage.textContent = '';
    hideWaiting();
    updateClearBtnState();
  }

  function updateClearBtnState() {
    const hasTimeline = messageTimeline.children.length > 0;
    const hasBlocks = blocksContainer.children.length > 0;
    const isWaiting = waitingEl && waitingEl.parentNode === messageTimeline;

    // 如果只有等待动画，视为无内容
    const hasActualContent = hasBlocks || (hasTimeline && (!isWaiting || messageTimeline.children.length > 1));

    clearBtn.disabled = !hasActualContent && !requestPending;
  }

  // Config modal events
  manageConfigBtn.addEventListener('click', () => {
    configModal.classList.add('open');
    // reset edit state when opening
    clearEditForm();
    displayConfigs();
  });
  closeConfigModalBtn.addEventListener('click', () => configModal.classList.remove('open'));
  window.addEventListener('click', (e) => { if (e.target === configModal) configModal.classList.remove('open'); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 若有自定义弹窗打开，仅关闭自定义弹窗，不关闭配置页
      if (document.querySelector('.app-modal.open')) return;
      configModal.classList.remove('open');
    }
  });

  configListEl.addEventListener('click', async (e) => {
    const starBtn = e.target.closest('[data-star]');
    if (starBtn) {
      const idx = parseInt(starBtn.getAttribute('data-star'), 10);
      const cfgs = loadConfigs();
      const wasDefault = !!(cfgs[idx] && cfgs[idx].isDefault);
      if (wasDefault) {
        // 取消默认，恢复系统预设
        cfgs.forEach((c) => { if (c) c.isDefault = false; });
        saveConfigs(cfgs);
        displayConfigs();
        applySystemDefaultToTop();
        appAlert('已取消默认，已恢复系统预设');
      } else {
        // 设为默认，并应用到顶部
        cfgs.forEach((c, i) => { if (c) c.isDefault = (i === idx); });
        saveConfigs(cfgs);
        displayConfigs();
        applyConfigToTop(cfgs[idx]);
        appAlert('已设为默认配置');
      }
      return;
    }
    const delBtn = e.target.closest('[data-del]');
    if (delBtn) {
      const idx = parseInt(delBtn.getAttribute('data-del'), 10);
      const confirmed = await openAppModal({ title: '确认删除', content: '确定要删除此配置吗？', showCancel: true, okText: '删除', cancelText: '取消' });
      if (!confirmed) return;
      const cfgs = loadConfigs();
      cfgs.splice(idx, 1);
      saveConfigs(cfgs);
      displayConfigs();
      return;
    }
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      const idx = parseInt(editBtn.getAttribute('data-edit'), 10);
      const cfg = loadConfigs()[idx];
      if (cfg) {
        editingIndex = idx;
        configNameEl.value = cfg.name || '';
        configUrlEl.value = cfg.url || '';
        configKeyEl.value = cfg.key || '';
        configModelEl.value = cfg.model || SYSTEM_DEFAULTS.model;
        saveConfigBtn.textContent = '保存修改';
        cancelEditBtn.style.display = '';
        if (saveAsDefaultBtn) saveAsDefaultBtn.style.display = 'none';
        // 保存按钮切换为蓝色
        if (saveConfigBtn) { saveConfigBtn.classList.remove('btn-secondary'); saveConfigBtn.classList.add('btn-primary'); }
        if (configModalTitleEl) configModalTitleEl.textContent = '修改 API 配置';
        if (modalFormHeadingEl) modalFormHeadingEl.textContent = '修改配置';
      }
      return;
    }
    const item = e.target.closest('.config-item');
    if (!item) return;
    const index = parseInt(item.getAttribute('data-index'), 10);
    const cfg = loadConfigs()[index];
    if (cfg) {
      apiUrlEl.value = cfg.url || '';
      apiKeyEl.value = cfg.key || '';
      modelEl.value = cfg.model || SYSTEM_DEFAULTS.model;
      configModal.classList.remove('open');
    }
  });

  // 普通保存：编辑时保留原 isDefault；新建为 false
  saveConfigBtn.addEventListener('click', async () => {
    const name = configNameEl.value.trim();
    const url = stripTrailingSlash(configUrlEl.value.trim());
    const key = configKeyEl.value.trim();
    const model = (configModelEl.value || SYSTEM_DEFAULTS.model).trim();
    if (!name || !url || !key) { await appAlert('请填写所有必填字段'); return; }
    const cfgs = loadConfigs();
    if (editingIndex !== null) {
      const prev = cfgs[editingIndex] || {};
      cfgs[editingIndex] = { ...prev, name, url, key, model };
    } else {
      cfgs.push({ name, url, key, model, isDefault: false });
    }
    saveConfigs(cfgs);
    clearEditForm();
    showToast('配置已保存', 'success');
    displayConfigs();
  });

  // 保存为默认配置：将该项设为唯一默认，并立即应用到顶部
  if (saveAsDefaultBtn) {
    saveAsDefaultBtn.addEventListener('click', async () => {
      const name = configNameEl.value.trim();
      const url = stripTrailingSlash(configUrlEl.value.trim());
      const key = configKeyEl.value.trim();
      const model = (configModelEl.value || SYSTEM_DEFAULTS.model).trim();
      if (!name || !url || !key) { await appAlert('请填写所有必填字段'); return; }
      const cfgs = loadConfigs();
      let idx;
      if (editingIndex !== null) {
        const prev = cfgs[editingIndex] || {};
        cfgs[editingIndex] = { ...prev, name, url, key, model, isDefault: true };
        idx = editingIndex;
      } else {
        cfgs.push({ name, url, key, model, isDefault: true });
        idx = cfgs.length - 1;
      }
      // 唯一默认
      cfgs.forEach((c, i) => { if (i !== idx && c) c.isDefault = false; });
      saveConfigs(cfgs);
      applyConfigToTop(cfgs[idx]);
      clearEditForm();
      showToast('已保存并设为默认配置', 'success');
      displayConfigs();
    });
  }

  function clearEditForm() {
    editingIndex = null;
    configNameEl.value = '';
    configUrlEl.value = '';
    configKeyEl.value = '';
    configModelEl.value = '';
    saveConfigBtn.textContent = '保存配置';
    cancelEditBtn.style.display = 'none';
    if (saveAsDefaultBtn) saveAsDefaultBtn.style.display = '';
    // 保存按钮恢复为灰色
    if (saveConfigBtn) { saveConfigBtn.classList.remove('btn-primary'); saveConfigBtn.classList.add('btn-secondary'); }
    if (configModalTitleEl) configModalTitleEl.textContent = '管理 API 配置';
    if (modalFormHeadingEl) modalFormHeadingEl.textContent = '添加新配置';
  }

  cancelEditBtn.addEventListener('click', () => {
    clearEditForm();
  });

  clearBtn.addEventListener('click', clearResults);

  // Defaults
  // Password toggle functionality
  function initPasswordToggles() {
    document.querySelectorAll('.password-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        const input = document.getElementById(targetId);
        const eyeIcon = btn.querySelector('.eye-icon');
        const eyeOffIcon = btn.querySelector('.eye-off-icon');

        if (input.type === 'password') {
          input.type = 'text';
          eyeIcon.style.display = 'none';
          eyeOffIcon.style.display = 'block';
          btn.setAttribute('aria-label', '隐藏密码');
        } else {
          input.type = 'password';
          eyeIcon.style.display = 'block';
          eyeOffIcon.style.display = 'none';
          btn.setAttribute('aria-label', '显示密码');
        }
      });
    });
  }

  // URL 输入框失焦时自动规范化
  apiUrlEl.addEventListener('blur', () => {
    apiUrlEl.value = normalizeApiUrl(apiUrlEl.value);
  });
  configUrlEl.addEventListener('blur', () => {
    configUrlEl.value = normalizeApiUrl(configUrlEl.value);
  });

  window.addEventListener('load', () => {
    // 初始化密码切换功能
    initPasswordToggles();

    // 自动应用默认配置
    const cfgs = loadConfigs();
    const d = cfgs.find(c => c && c.isDefault);
    if (d) {
      apiUrlEl.value = d.url || apiUrlEl.value || SYSTEM_DEFAULTS.apiUrl;
      apiKeyEl.value = d.key || SYSTEM_DEFAULTS.apiKey;
      modelEl.value = d.model || modelEl.value || SYSTEM_DEFAULTS.model;
    } else {
      if (!apiUrlEl.value) { apiUrlEl.value = SYSTEM_DEFAULTS.apiUrl; }
      if (!modelEl.value) { modelEl.value = SYSTEM_DEFAULTS.model; }
    }
    // 占位留空：不再动态写入 placeholder
    // 初始化厂商分组和测试按钮
    renderTestButtons('openai');
    updateClearBtnState();
  });

  // 厂商分组配置
  const vendorTests = {
    openai: [
      { scenario: 'openai_tools', label: '工具调用 (Chat Completions)', defaultInput: 'RANDOM_CONVERT_TASK' },
      { scenario: 'responses_tools', label: '工具调用 (Responses)', defaultInput: 'RANDOM_CONVERT_TASK' },
      { scenario: 'responses_search', label: '搜索 (Responses)', defaultInput: '搜索当前最新的Gemini旗舰模型是？' },
      { scenario: 'openai_image', label: '图片支持', defaultInput: '请描述这张图片' }
    ],
    anthropic: [
      { scenario: 'anthropic_tools', label: '工具调用', defaultInput: 'RANDOM_CONVERT_TASK' },
      { scenario: 'anthropic_image', label: '图片支持', defaultInput: '请描述这张图片' }
    ],
    google: [
      { scenario: 'gemini_tools', label: '工具调用', defaultInput: 'RANDOM_CONVERT_TASK' },
      { scenario: 'gemini_search', label: '搜索', defaultInput: '搜索当前最新的Gemini旗舰模型是？' },
      { scenario: 'gemini_url_context', label: 'URL 上下文', defaultInput: '这个工具有哪些特点？https://ai.google.dev/gemini-api/docs/url-context' },
      { scenario: 'gemini_image', label: '图片支持', defaultInput: '请描述这张图片' }
    ]
  };

  let activeExpectedAnswer = null;
  function generateRandomTask() {
    const val = Math.floor(Math.random() * 16777215);
    const bases = [2, 8, 10, 16];
    const baseNames = { 2: '二进制', 8: '八进制', 10: '十进制', 16: '十六进制' };

    // 随机选择三个互不相同的进制
    let shuffled = [...bases].sort(() => 0.5 - Math.random());
    const [b1, b2, b3] = shuffled;

    const startNum = val.toString(b1).toUpperCase();
    activeExpectedAnswer = val.toString(b3).toUpperCase();

    return `请将${baseNames[b1]}数 ${startNum} 转换为${baseNames[b2]}，然后再将该${baseNames[b2]}结果转换为${baseNames[b3]}。待转换完成后，你必须调用 submit_answer 工具提交最终的${baseNames[b3]}结果，系统将验证你的答案是否正确。`;
  }

  // 当前选中的厂商
  let currentVendor = 'openai';

  // 图片场景列表
  const IMAGE_SCENARIOS = ['openai_image', 'anthropic_image', 'gemini_image'];
  // 默认测试图片（base64 内嵌，无需网络加载）
  const DEFAULT_TEST_IMAGE = 'data:image/png;base64,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';

  // 切换测试场景工具函数
  function applyScenarioInput(scenario, defaultInput) {
    const isToolScenario = ['openai_tools', 'anthropic_tools', 'gemini_tools', 'responses_tools'].includes(scenario);
    const isImageScenario = IMAGE_SCENARIOS.includes(scenario);
    const label = document.querySelector('label[for="userInput"]');

    // 图片场景：显示图片输入区域，并自动加载默认测试图片
    if (isImageScenario) {
      imageInputArea.style.display = '';
      if (!currentImageData) {
        loadImageUrl(DEFAULT_TEST_IMAGE);
      }
    } else {
      imageInputArea.style.display = 'none';
      // 退出图片场景时清理图片
      clearImageInput();
    }

    if (isToolScenario) {
      if (defaultInput === 'RANDOM_CONVERT_TASK') {
        userInputEl.value = generateRandomTask();
      } else {
        userInputEl.value = defaultInput;
      }
      userInputEl.readOnly = true;
      if (label && !label.querySelector('.label-hint')) {
        label.style.display = 'flex';
        label.style.alignItems = 'center';
        const hint = document.createElement('span');
        hint.className = 'label-hint';
        hint.style.cssText = 'color: #94a3b8; font-size: 0.75rem; font-weight: normal; margin-left: 8px; line-height: 1.4;';
        hint.textContent = '(系统会自动验证，无需修改)';
        label.appendChild(hint);
      }
    } else {
      userInputEl.value = defaultInput;
      userInputEl.readOnly = false;
      const hint = label ? label.querySelector('.label-hint') : null;
      if (hint) hint.remove();
    }
  }

  // 清理图片输入
  function clearImageInput() {
    imageFileInput.value = '';
    imageUrlInput.value = '';
    imagePreview.style.display = 'none';
    previewImg.src = '';
    imageInfo.textContent = '';
    currentImageData = null;
  }

  // 显示图片预览
  function showImagePreview(src, info) {
    previewImg.src = src;
    imageInfo.textContent = info;
    imagePreview.style.display = 'flex';
  }

  // 读取本地图片文件
  function loadImageFile(file) {
    if (!file) return;
    // 校验文件类型
    if (!file.type || !file.type.startsWith('image/')) {
      appAlert('请选择图片文件');
      return;
    }
    // 限制文件大小（10MB）
    if (file.size > 10 * 1024 * 1024) {
      appAlert('图片文件过大，请选择小于 10MB 的图片');
      return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
      currentImageData = e.target.result;
      showImagePreview(currentImageData, `${file.name} (${(file.size / 1024).toFixed(1)}KB)`);
    };
    reader.readAsDataURL(file);
  }

  // 使用 URL 作为图片源
  function loadImageUrl(url) {
    const trimmed = url.trim();
    if (!trimmed) return;
    currentImageData = trimmed;
    showImagePreview(trimmed, trimmed);
  }

  // 图片文件选择事件
  imageFileInput.addEventListener('change', function () {
    if (this.files && this.files[0]) {
      loadImageFile(this.files[0]);
      // 清空 URL 输入
      imageUrlInput.value = '';
    }
  });

  // 图片 URL 输入事件（回车确认）
  imageUrlInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && this.value.trim()) {
      // 清空文件选择
      imageFileInput.value = '';
      loadImageUrl(this.value);
    }
  });

  // 图片 URL 失焦时加载
  imageUrlInput.addEventListener('blur', function () {
    if (this.value.trim()) {
      imageFileInput.value = '';
      loadImageUrl(this.value);
    }
  });

  // 移除图片
  removeImageBtn.addEventListener('click', clearImageInput);

  // ---- 从 API 获取模型列表 ----
  let cachedModels = []; // 缓存已获取的模型列表
  let fetchAbortController = null;

  async function fetchModelsFromEndpoint() {
    const apiUrl = apiUrlEl.value.trim();
    const apiKey = apiKeyEl.value.trim();
    if (!apiUrl || !apiKey) {
      renderModelDropdownError('请先填写 API URL 和 API Key');
      return;
    }

    // 中止上一次请求
    if (fetchAbortController) fetchAbortController.abort();
    fetchAbortController = new AbortController();
    const signal = fetchAbortController.signal;

    fetchModelsBtn.classList.add('loading');
    modelDropdown.style.display = '';
    modelDropdown.innerHTML = '<div class="model-dropdown-empty">加载中...</div>';

    try {
      const normalizedUrl = stripTrailingSlash(apiUrl);
      const modelUrl = `${normalizedUrl}/v1/models`;
      const res = await fetch(modelUrl, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal
      });
      if (signal.aborted) return;

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 120) : ''}`);
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('json')) {
        throw new Error('响应非 JSON，该 API 不支持模型列表查询');
      }

      const data = await res.json();
      if (signal.aborted) return;

      const models = Array.isArray(data.data) ? data.data : [];
      if (models.length === 0) {
        renderModelDropdownEmpty('未获取到可用模型');
        return;
      }

      cachedModels = models;
      renderModelDropdown(models);
    } catch (err) {
      if (err.name === 'AbortError') return;
      renderModelDropdownError(err.message || '获取模型列表失败');
    } finally {
      fetchModelsBtn.classList.remove('loading');
    }
  }

  function renderModelDropdown(models) {
    // 去重（按 id），按 name/id 排序
    const seen = new Set();
    const unique = models.filter(m => {
      const id = m.id || m.name || '';
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    unique.sort((a, b) => ((a.id || a.name) || '').localeCompare((b.id || b.name) || ''));

    modelDropdown.innerHTML = unique.map(m => {
      const id = m.id || m.name || 'unknown';
      const owned = m.owned_by ? `<span class="model-meta">${m.owned_by}</span>` : '';
      return `<div class="model-dropdown-item" data-model="${id.replace(/"/g, '&quot;')}">
        <span class="model-id">${id}</span>${owned}
      </div>`;
    }).join('');
    modelDropdown.style.display = '';

    // 点击选项填充到输入框并关闭下拉
    modelDropdown.querySelectorAll('.model-dropdown-item').forEach(el => {
      el.addEventListener('click', () => {
        modelEl.value = el.dataset.model;
        closeModelDropdown();
      });
    });
  }

  function renderModelDropdownError(msg) {
    modelDropdown.innerHTML = `<div class="model-dropdown-error">${escapeHtml(msg)}</div>`;
    modelDropdown.style.display = '';
  }

  function renderModelDropdownEmpty(msg) {
    modelDropdown.innerHTML = `<div class="model-dropdown-empty">${escapeHtml(msg || '暂无可用模型')}</div>`;
    modelDropdown.style.display = '';
  }

  function closeModelDropdown() {
    modelDropdown.style.display = 'none';
  }

  // 获取模型列表按钮点击
  fetchModelsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // 如果下拉已显示且有缓存，直接显示缓存；否则重新拉取
    if (modelDropdown.style.display !== 'none' && cachedModels.length > 0) {
      closeModelDropdown();
    } else if (cachedModels.length > 0) {
      renderModelDropdown(cachedModels);
    } else {
      fetchModelsFromEndpoint();
    }
  });

  // 点击外部关闭下拉
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.model-input-group')) {
      closeModelDropdown();
    }
  });

  // 模型输入框获得焦点时，如果有缓存则自动显示下拉
  modelEl.addEventListener('focus', () => {
    if (cachedModels.length > 0) {
      renderModelDropdown(cachedModels);
    }
  });

  // 渲染测试按钮
  function renderTestButtons(vendor) {
    const tests = vendorTests[vendor] || [];
    testTypeWrap.innerHTML = tests.map((t, i) =>
      `<button class="seg-btn${i === 0 ? ' active' : ''}" data-scenario="${t.scenario}">${t.label}</button>`
    ).join('');
    // 设置默认输入
    if (tests.length > 0) {
      applyScenarioInput(tests[0].scenario, tests[0].defaultInput);
    }
  }

  // 切换厂商
  function setActiveVendor(vendor) {
    abortCurrentRequest();
    currentVendor = vendor;
    $$('#vendorType .seg-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.vendor === vendor));
    renderTestButtons(vendor);
    clearResults();
  }

  // 切换测试场景
  function setActiveScenario(scenario) {
    abortCurrentRequest();
    $$('#testType .seg-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.scenario === scenario));
    // 查找对应的默认输入
    const tests = vendorTests[currentVendor] || [];
    const test = tests.find(t => t.scenario === scenario);
    if (test) {
      applyScenarioInput(scenario, test.defaultInput);
    }
  }

  // 厂商切换事件
  if (vendorTypeWrap) {
    vendorTypeWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn || !btn.dataset.vendor) return;
      setActiveVendor(btn.dataset.vendor);
    });
  }

  // 测试场景切换事件
  if (testTypeWrap) {
    testTypeWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn || !btn.dataset.scenario) return;
      setActiveScenario(btn.dataset.scenario);
      clearResults();
    });
  }

  // Test function call flow (multiple scenarios)
  testBtn.addEventListener('click', async () => {
    abortCurrentRequest();
    const apiUrl = apiUrlEl.value.trim();
    const apiKey = apiKeyEl.value.trim();
    const model = (modelEl.value || SYSTEM_DEFAULTS.model).trim();
    if (!apiUrl || !apiKey) { await appAlert('请填写 API URL 和 API Key'); return; }
    errorMessage.textContent = '';
    testBtn.disabled = true; testBtn.textContent = '请求中...';
    // 发起新请求前自动清空历史记录
    clearResults();
    requestPending = true; // 确保在 updateClearBtnState 之前设置
    updateClearBtnState();

    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    const scenario = testTypeWrap.querySelector('.seg-btn.active')?.dataset.scenario || 'openai_tools';
    const endpoint = buildEndpoint(apiUrl);
    const geminiEndpoint = buildGeminiEndpoint(apiUrl, model, apiKey);
    const anthropicEndpoint = buildAnthropicEndpoint(apiUrl);

    try {
      requestPending = true; showWaiting();
      let userText = userInputEl.value.trim() || '当前时间是？';

      // 如果是工具场景且输入是默认标记，则生成随机题目
      if (['openai_tools', 'anthropic_tools', 'gemini_tools', 'responses_tools'].includes(scenario)) {
        if (userText === 'RANDOM_CONVERT_TASK' || userText.includes('ABCDEF12')) {
          userText = generateRandomTask();
          userInputEl.value = userText;
        }
      }

      // 图片场景：检查是否已加载图片
      if (IMAGE_SCENARIOS.includes(scenario) && !currentImageData) {
        await appAlert('请先选择一张图片或输入图片 URL');
        throw new Error('ABORT_SILENT');
      }

      if (scenario === 'openai_tools') {
        const tools = [
          {
            type: 'function',
            function: {
              name: 'convert_base',
              description: '将数字从一种进制转换为另一种进制',
              parameters: {
                type: 'object',
                properties: {
                  number: { type: 'string', description: '待转换的数字' },
                  from_base: { type: 'integer', description: '原进制 (如 2, 10, 16)' },
                  to_base: { type: 'integer', description: '目标进制 (如 2, 10, 16)' }
                },
                required: ['number', 'from_base', 'to_base']
              }
            }
          },
          {
            type: 'function',
            function: {
              name: 'submit_answer',
              description: '提交最终计算出的结果答案以供验证',
              parameters: {
                type: 'object',
                properties: {
                  answer: { type: 'string', description: '最终转换出的字符串结果' }
                },
                required: ['answer']
              }
            }
          }
        ];

        let messages = [
          { role: 'system', content: '你不仅能够调用 convert_base 工具，还必须在得到最终计算结果后调用 submit_answer 工具来提交最终答案。' },
          { role: 'user', content: userText }
        ];
        addMessage('user', '用户消息 #1', messages[1]);

        let turn = 1;
        let hasSubmittedAnswer = false;
        let validationStatus = null; // null: not run, true: correct, false: error
        let validationMsg = '';

        const MAX_TURNS = 8;
        while (turn <= MAX_TURNS) {
          const requestBody = { model, messages, tools, tool_choice: 'auto' };
          addBlock(`请求 #${turn}`, requestBody);

          const tStart = Date.now();
          const r = await fetchAndParse(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(requestBody),
            signal
          });
          const data = ensureJsonOrThrow(r);
          const duration = Date.now() - tStart;
          addBlock(`响应 #${turn}`, data, duration);

          const choice = data.choices && data.choices[0];
          if (!choice) break;
          const assistantMsg = choice.message;
          messages.push(assistantMsg);
          addMessage('assistant', `模型响应 #${turn}`, assistantMsg);

          if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
            for (const toolCall of assistantMsg.tool_calls) {
              let toolResults = { error: 'Unknown function' };
              if (toolCall.function.name === 'convert_base') {
                try {
                  const args = JSON.parse(toolCall.function.arguments || '{}');
                  const val = parseInt(args.number, args.from_base);
                  toolResults = isNaN(val) ? { error: 'Invalid input' } : { result: val.toString(args.to_base) };
                } catch (e) { toolResults = { error: e.message }; }
              } else if (toolCall.function.name === 'submit_answer') {
                hasSubmittedAnswer = true;
                try {
                  const args = JSON.parse(toolCall.function.arguments || '{}');
                  const isCorrect = String(args.answer).toUpperCase() === activeExpectedAnswer;
                  validationStatus = isCorrect;
                  toolResults = { success: isCorrect, message: isCorrect ? '验证通过！答案正确。' : `验证失败。预期结果为: ${activeExpectedAnswer}` };
                  if (isCorrect) {
                    validationMsg = '经过多轮工具调用，模型成功识别并完成了任务，且最终答案验证正确！';
                  } else {
                    validationMsg = `经过多轮工具调用，模型虽然尝试完成任务，但最终提交的答案验证错误（提交值: ${args.answer}）。`;
                  }
                } catch (e) { toolResults = { error: e.message }; }
              }
              const toolMessage = {
                role: 'tool',
                content: JSON.stringify(toolResults),
                tool_call_id: toolCall.id
              };
              messages.push(toolMessage);
              addMessage('tool', `工具执行 #${turn}`, toolResults);
            }
            turn++;
          } else {
            break;
          }
        }

        if (validationStatus === true) addInlineSuccess(validationMsg);
        else if (validationStatus === false) addInlineError(validationMsg);
        else if (!hasSubmittedAnswer) addInlineInfo('模型未执行最终的答案提交工具，流程提前结束。');
      }
      else if (scenario === 'anthropic_tools') {
        const tools = [
          {
            name: 'convert_base',
            description: '将数字从一种进制转换为另一种进制',
            input_schema: {
              type: 'object',
              properties: {
                number: { type: 'string', description: '待转换的数字' },
                from_base: { type: 'integer', description: '原进制 (如 2, 10, 16)' },
                to_base: { type: 'integer', description: '目标进制 (如 2, 10, 16)' }
              },
              required: ['number', 'from_base', 'to_base']
            }
          },
          {
            name: 'submit_answer',
            description: '提交最终计算出的结果答案以供验证',
            input_schema: {
              type: 'object',
              properties: {
                answer: { type: 'string', description: '最终转换出的字符串结果' }
              },
              required: ['answer']
            }
          }
        ];

        let messages = [{ role: 'user', content: userText }];
        addMessage('user', '用户消息 #1', messages[0]);

        let turn = 1;
        let hasSubmittedAnswer = false;
        let validationStatus = null;
        let validationMsg = '';

        const A_SYSTEM_INSTRUCTION = '你不仅能够调用 convert_base 工具，还必须在得到最终计算结果后调用 submit_answer 工具来提交最终答案。';

        const MAX_TURNS = 8;
        while (turn <= MAX_TURNS) {
          const aReq = {
            model,
            max_tokens: 1024,
            messages,
            tools,
            system: A_SYSTEM_INSTRUCTION
          };
          addBlock(`请求 #${turn}`, aReq);
          const aTStart = Date.now();
          const aR = await fetchAndParse(anthropicEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(aReq),
            signal
          });
          const aData = ensureJsonOrThrow(aR);
          const aTDuration = Date.now() - aTStart;
          addBlock(`响应 #${turn}`, aData, aTDuration);

          const contentArr = Array.isArray(aData && aData.content) ? aData.content : [];
          messages.push({ role: 'assistant', content: contentArr });
          addMessage('assistant', `模型响应 #${turn}`, contentArr);

          const toolUses = contentArr.filter(p => p && p.type === 'tool_use');
          if (toolUses.length > 0) {
            const toolResultsParts = [];
            for (const toolUse of toolUses) {
              let toolResults = { error: 'Unknown function' };
              if (toolUse.name === 'convert_base') {
                try {
                  const args = toolUse.input || {};
                  const val = parseInt(args.number, args.from_base);
                  toolResults = isNaN(val) ? { error: 'Invalid input' } : { result: val.toString(args.to_base) };
                } catch (e) { toolResults = { error: e.message }; }
              } else if (toolUse.name === 'submit_answer') {
                hasSubmittedAnswer = true;
                try {
                  const args = toolUse.input || {};
                  const isCorrect = String(args.answer).toUpperCase() === activeExpectedAnswer;
                  validationStatus = isCorrect;
                  toolResults = { success: isCorrect, message: isCorrect ? '验证通过！答案正确。' : `验证失败。预期结果为: ${activeExpectedAnswer}` };
                  if (isCorrect) {
                    validationMsg = '经过多轮工具调用，模型成功识别并完成了任务，且最终答案验证正确！';
                  } else {
                    validationMsg = `经过多轮工具调用，模型虽然尝试完成任务，但最终提交的答案验证错误（提交值: ${args.answer}）。`;
                  }
                } catch (e) { toolResults = { error: e.message }; }
              }
              toolResultsParts.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(toolResults)
              });
              addMessage('tool', `工具执行 #${turn}`, toolResults);
            }
            messages.push({ role: 'user', content: toolResultsParts });
            turn++;
          } else {
            break;
          }
        }

        if (validationStatus === true) addInlineSuccess(validationMsg);
        else if (validationStatus === false) addInlineError(validationMsg);
        else if (!hasSubmittedAnswer) addInlineInfo('模型未执行最终的答案提交工具，流程提前结束。');
      }
      else if (scenario === 'gemini_tools') {
        const functionDeclarations = [
          {
            name: 'convert_base',
            description: '将数字从一种进制转换为另一种进制',
            parameters: {
              type: 'object',
              properties: {
                number: { type: 'string', description: '待转换的数字' },
                from_base: { type: 'integer', description: '原进制 (如 2, 10, 16)' },
                to_base: { type: 'integer', description: '目标进制 (如 2, 10, 16)' }
              },
              required: ['number', 'from_base', 'to_base']
            }
          },
          {
            name: 'submit_answer',
            description: '提交最终计算出的结果答案以供验证',
            parameters: {
              type: 'object',
              properties: {
                answer: { type: 'string', description: '最终转换出的字符串结果' }
              },
              required: ['answer']
            }
          }
        ];

        let contents = [{ role: 'user', parts: [{ text: userText }] }];
        addMessage('user', '用户消息 #1', contents[0]);

        let turn = 1;
        let hasSubmittedAnswer = false;
        let validationStatus = null;
        let validationMsg = '';

        const MAX_TURNS = 8;
        while (turn <= MAX_TURNS) {
          const gReq = {
            systemInstruction: { parts: [{ text: '你是一个有帮助的助手。你不仅能够调用 convert_base 工具，还必须在得到最终计算结果后调用 submit_answer 工具来提交最终答案。' }] },
            tools: [{ functionDeclarations }],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
            contents
          };
          addBlock(`请求 #${turn}`, gReq);

          const gTStart = Date.now();
          const gR = await fetchAndParse(geminiEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gReq), signal });
          const gData = ensureJsonOrThrow(gR);
          const gTDuration = Date.now() - gTStart;
          addBlock(`响应 #${turn}`, gData, gTDuration);

          const cand = gData.candidates && gData.candidates[0];
          const gContent = cand && cand.content;
          if (!gContent) break;

          contents.push(gContent);
          addMessage('assistant', `模型响应 #${turn}`, gContent);

          const fcs = (gContent.parts || []).filter(p => p.functionCall);
          if (fcs.length > 0) {
            const responseParts = [];
            for (const part of fcs) {
              const fc = part.functionCall;
              let toolResults = { error: 'Unknown function' };
              if (fc.name === 'convert_base') {
                try {
                  const args = fc.args || {};
                  const val = parseInt(args.number, args.from_base);
                  toolResults = isNaN(val) ? { error: 'Invalid input' } : { result: val.toString(args.to_base) };
                } catch (e) { toolResults = { error: e.message }; }
              } else if (fc.name === 'submit_answer') {
                hasSubmittedAnswer = true;
                try {
                  const args = fc.args || {};
                  const isCorrect = String(args.answer).toUpperCase() === activeExpectedAnswer;
                  validationStatus = isCorrect;
                  toolResults = { success: isCorrect, message: isCorrect ? '验证通过！答案正确。' : `验证失败。预期结果为: ${activeExpectedAnswer}` };
                  if (isCorrect) {
                    validationMsg = '经过多轮工具调用，模型成功识别并完成了任务，且最终答案验证正确！';
                  } else {
                    validationMsg = `经过多轮工具调用，模型虽然尝试完成任务，但最终提交的答案验证错误（提交值: ${args.answer}）。`;
                  }
                } catch (e) { toolResults = { error: e.message }; }
              }
              responseParts.push({
                functionResponse: { name: fc.name, response: toolResults }
              });
              addMessage('tool', `工具执行 #${turn}`, toolResults);
            }
            contents.push({ role: 'function', parts: responseParts });
            turn++;
          } else {
            break;
          }
        }

        if (validationStatus === true) addInlineSuccess(validationMsg);
        else if (validationStatus === false) addInlineError(validationMsg);
        else if (!hasSubmittedAnswer) addInlineInfo('模型未执行最终的答案提交工具，流程提前结束。');
      }
      else if (scenario === 'responses_tools') {
        const responsesEndpoint = buildResponsesEndpoint(apiUrl);
        const tools = [
          {
            type: 'function',
            name: 'convert_base',
            description: '将数字从一种进制转换为另一种进制',
            strict: true,
            parameters: {
              type: 'object',
              properties: {
                number: { type: 'string', description: '待转换的数字' },
                from_base: { type: 'integer', description: '原进制 (如 2, 10, 16)' },
                to_base: { type: 'integer', description: '目标进制 (如 2, 10, 16)' }
              },
              required: ['number', 'from_base', 'to_base'],
              additionalProperties: false
            }
          },
          {
            type: 'function',
            name: 'submit_answer',
            description: '提交最终计算出的结果答案以供验证',
            strict: true,
            parameters: {
              type: 'object',
              properties: {
                answer: { type: 'string', description: '最终转换出的字符串结果' }
              },
              required: ['answer'],
              additionalProperties: false
            }
          }
        ];

        let history = [{ role: 'user', content: userText }];
        addMessage('user', '用户消息 #1', history[0]);

        let turn = 1;
        let hasSubmittedAnswer = false;
        let validationStatus = null;
        let validationMsg = '';

        const MAX_TURNS = 8;
        while (turn <= MAX_TURNS) {
          const rtReq = { model, tools, input: history, instructions: '你不仅能够调用 convert_base 工具，还必须在得到最终计算结果后调用 submit_answer 工具来提交最终答案。' };
          addBlock(`请求 #${turn}`, rtReq);

          const rtTStart = Date.now();
          const rtR = await fetchAndParse(responsesEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(rtReq),
            signal
          });
          const rtData = ensureJsonOrThrow(rtR);
          const rtTDuration = Date.now() - rtTStart;
          addBlock(`响应 #${turn}`, rtData, rtTDuration);

          const outputs = Array.isArray(rtData.output) ? rtData.output : [];
          history.push(...outputs);

          if (rtData.output_text) {
            addMessage('assistant', `模型响应 #${turn}`, { text: rtData.output_text });
          } else {
            const msgItem = outputs.find(item => item && item.type === 'message');
            if (msgItem && msgItem.content) {
              addMessage('assistant', `模型响应 #${turn}`, msgItem.content);
            } else if (outputs.length > 0) {
              addMessage('assistant', `模型响应 #${turn}`, outputs);
            }
          }

          const fcs = outputs.filter(item => item && item.type === 'function_call');
          if (fcs.length > 0) {
            for (const fc of fcs) {
              let toolResults = { error: 'Unknown function' };
              if (fc.name === 'convert_base') {
                try {
                  const args = JSON.parse(fc.arguments || '{}');
                  const val = parseInt(args.number, args.from_base);
                  toolResults = isNaN(val) ? { error: 'Invalid input' } : { result: val.toString(args.to_base) };
                } catch (e) { toolResults = { error: e.message }; }
              } else if (fc.name === 'submit_answer') {
                hasSubmittedAnswer = true;
                try {
                  const args = JSON.parse(fc.arguments || '{}');
                  const isCorrect = String(args.answer).toUpperCase() === activeExpectedAnswer;
                  validationStatus = isCorrect;
                  toolResults = { success: isCorrect, message: isCorrect ? '验证通过！答案正确。' : `验证失败。预期结果为: ${activeExpectedAnswer}` };
                  if (isCorrect) {
                    validationMsg = '经过多轮工具调用，模型成功识别并完成了任务，且最终答案验证正确！';
                  } else {
                    validationMsg = `经过多轮工具调用，模型虽然尝试完成任务，但最终提交的答案验证错误（提交值: ${args.answer}）。`;
                  }
                } catch (e) { toolResults = { error: e.message }; }
              }
              const outputItem = {
                type: 'function_call_output',
                call_id: fc.call_id,
                output: JSON.stringify(toolResults)
              };
              history.push(outputItem);
              addMessage('tool', `工具执行 #${turn}`, toolResults);
            }
            turn++;
          } else {
            break;
          }
        }

        if (validationStatus === true) addInlineSuccess(validationMsg);
        else if (validationStatus === false) addInlineError(validationMsg);
        else if (!hasSubmittedAnswer) addInlineInfo('模型未执行最终的答案提交工具，流程提前结束。');
      }
      else if (scenario === 'responses_search') {
        // OpenAI Responses API with web_search tool 
        const responsesEndpoint = buildResponsesEndpoint(apiUrl);
        const rReq = {
          model,
          tools: [{ type: 'web_search' }],
          input: [{ role: 'user', content: userText || '搜索当前最新的Gemini旗舰模型是？' }]
        };
        addBlock('请求 #1', rReq);
        addMessage('user', '用户消息', rReq.input[0]);
        const rTStart = Date.now();
        const rR = await fetchAndParse(responsesEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify(rReq),
          signal
        });
        const rData = ensureJsonOrThrow(rR);
        const rTDuration = Date.now() - rTStart;
        addBlock('响应 #1', rData, rTDuration);

        // 检测是否存在 web_search_call
        const output = rData.output;
        let hasWebSearchCall = false;
        if (Array.isArray(output)) {
          hasWebSearchCall = output.some(item => item && item.type === 'web_search_call');
        }

        // 显示回答内容
        if (rData.output_text) {
          addMessage('assistant', '回答', { text: rData.output_text });
        } else if (Array.isArray(output)) {
          const msgItem = output.find(item => item && item.type === 'message');
          if (msgItem && msgItem.content) {
            addMessage('assistant', '回答', msgItem.content);
          }
        }

        // 未触发搜索工具调用的提示放在响应下面
        if (!hasWebSearchCall) {
          addInlineInfo('未触发搜索工具调用：模型可能未理解指令，或 API 异常。');
        } else {
          addInlineSuccess('模型成功进行了搜索工具调用，但回答中仍可能含有事实性错误');
        }
      }
      else if (scenario === 'gemini_search') {
        const gReq = {
          tools: [{ googleSearch: {} }],
          contents: [{ role: 'user', parts: [{ text: userText || '搜索当前最新的Gemini旗舰模型是？' }] }]
        };
        addBlock('请求 #1', gReq);
        addMessage('user', '用户消息', gReq.contents[0]);
        const gsTStart = Date.now();
        const gR = await fetchAndParse(geminiEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gReq), signal });
        const gData = ensureJsonOrThrow(gR);
        const gsTDuration = Date.now() - gsTStart;
        addBlock('响应 #1', gData, gsTDuration);
        const cand = gData.candidates && gData.candidates[0];
        if (cand && cand.content) { addMessage('assistant', '回答', cand.content); }

        // 检测是否存在 groundingMetadata
        const hasGroundingMetadata = cand && cand.groundingMetadata;
        if (!hasGroundingMetadata) {
          addInlineInfo('未触发搜索工具调用：模型可能未理解指令，或 API 异常。');
        } else {
          addInlineSuccess('模型成功进行了搜索工具调用，但回答中仍可能含有事实性错误');
        }
      }
      else if (scenario === 'gemini_url_context') {
        const gReq = {
          tools: [{ urlContext: {} }],
          contents: [{ role: 'user', parts: [{ text: userText || '这个工具有哪些特点？https://ai.google.dev/gemini-api/docs/url-context' }] }]
        };
        addBlock('请求 #1', gReq);
        addMessage('user', '用户消息', gReq.contents[0]);
        const guTStart = Date.now();
        const gR = await fetchAndParse(geminiEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gReq), signal });
        const gData = ensureJsonOrThrow(gR);
        const guTDuration = Date.now() - guTStart;
        addBlock('响应 #1', gData, guTDuration);
        const cand = gData.candidates && gData.candidates[0];
        if (cand && cand.content) { addMessage('assistant', '回答', cand.content); }

        // 检测是否存在 groundingMetadata
        const hasGroundingMetadata = cand && cand.groundingMetadata;
        if (!hasGroundingMetadata) {
          addInlineInfo('未触发 URL 上下文工具调用：模型可能未理解指令，或 API 异常。');
        } else {
          addInlineSuccess('模型成功进行了搜索工具调用，但回答中仍可能含有事实性错误');
        }
      }
      else if (scenario === 'openai_image') {
        // OpenAI Chat Completions 图片支持测试（单轮）
        const contentParts = [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: currentImageData } }
        ];
        const oReq = { model, messages: [{ role: 'user', content: contentParts }] };
        addBlock('请求 #1', oReq);
        addMessage('user', '用户消息', contentParts);
        const oTStart = Date.now();
        const oR = await fetchAndParse(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify(oReq),
          signal
        });
        const oData = ensureJsonOrThrow(oR);
        const oTDuration = Date.now() - oTStart;
        addBlock('响应 #1', oData, oTDuration);
        const choice = oData.choices && oData.choices[0];
        if (choice && choice.message) {
          addMessage('assistant', '回答', choice.message);
          addInlineSuccess('图片已成功被模型识别并处理');
        } else {
          addInlineError('模型未能处理图片，该 API 可能不支持图片输入');
        }
      }
      else if (scenario === 'anthropic_image') {
        // Anthropic 图片支持测试（单轮）
        let source;
        if (currentImageData.startsWith('data:')) {
          const matches = currentImageData.match(/^data:(image\/\w+);base64,(.+)$/);
          if (!matches) {
            await appAlert('无法解析图片数据，请重新选择');
            throw new Error('ABORT_SILENT');
          }
          source = { type: 'base64', media_type: matches[1], data: matches[2] };
        } else {
          source = { type: 'url', url: currentImageData };
        }
        const aReq = {
          model,
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: userText },
              { type: 'image', source }
            ]
          }]
        };
        addBlock('请求 #1', aReq);
        addMessage('user', '用户消息', aReq.messages[0].content);
        const aTStart = Date.now();
        const aR = await fetchAndParse(anthropicEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(aReq),
          signal
        });
        const aData = ensureJsonOrThrow(aR);
        const aTDuration = Date.now() - aTStart;
        addBlock('响应 #1', aData, aTDuration);
        if (aData.content && aData.content.length > 0) {
          addMessage('assistant', '回答', aData.content);
          addInlineSuccess('图片已成功被模型识别并处理');
        } else {
          addInlineError('模型未能处理图片，该 API 可能不支持图片输入');
        }
      }
      else if (scenario === 'gemini_image') {
        // Google Gemini 图片支持测试（单轮）
        let imagePart;
        if (currentImageData.startsWith('data:')) {
          const matches = currentImageData.match(/^data:(image\/\w+);base64,(.+)$/);
          if (!matches) {
            await appAlert('无法解析图片数据，请重新选择');
            throw new Error('ABORT_SILENT');
          }
          imagePart = { inline_data: { mime_type: matches[1], data: matches[2] } };
        } else {
          imagePart = { fileData: { fileUri: currentImageData } };
        }
        const gReq = {
          contents: [{
            role: 'user',
            parts: [
              { text: userText },
              imagePart
            ]
          }]
        };
        addBlock('请求 #1', gReq);
        addMessage('user', '用户消息', gReq.contents[0]);
        const gTStart = Date.now();
        const gR = await fetchAndParse(geminiEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(gReq),
          signal
        });
        const gData = ensureJsonOrThrow(gR);
        const gTDuration = Date.now() - gTStart;
        addBlock('响应 #1', gData, gTDuration);
        const cand = gData.candidates && gData.candidates[0];
        if (cand && cand.content) {
          addMessage('assistant', '回答', cand.content);
          addInlineSuccess('图片已成功被模型识别并处理');
        } else {
          addInlineError('模型未能处理图片，该 API 可能不支持图片输入');
        }
      }

    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('Request aborted by user');
        return;
      }
      if (err && err.message === 'ABORT_SILENT') {
        return;
      }
      console.error(err);
      // 清空顶部简要错误，改为在时间线内展示红色错误块
      errorMessage.textContent = '';
      addInlineError(`错误：${err && (err.message || err)}`, { rawText: err && err.rawText, contentType: err && err.contentType });
    } finally {
      requestPending = false;
      hideWaiting();
      testBtn.disabled = false; testBtn.textContent = '发送测试请求';
      updateClearBtnState();
    }
  });

  // ---- network helpers ----
  async function fetchAndParse(url, options) {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { }
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; e.rawText = text; e.contentType = contentType; throw e; }
    return { json, text, contentType };
  }
  function ensureJsonOrThrow(parsed) {
    if (parsed && parsed.json) return parsed.json;
    const e = new Error('响应非 JSON');
    e.rawText = parsed && parsed.text;
    e.contentType = parsed && parsed.contentType;
    throw e;
  }
})();
