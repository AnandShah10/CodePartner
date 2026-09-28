(function () {
  const vscode = acquireVsCodeApi();

  // Phase 4.6: VS Code doesn't natively provide "-rgb" custom properties
  // usable inside rgba(var(--x-rgb), alpha) — it only exposes theme
  // colors as full CSS color values (e.g. "#1e1e1e"). This stylesheet
  // references e.g. --vscode-editor-background-rgb throughout expecting
  // a bare "r,g,b" triplet, but nothing ever defined it, so every one of
  // those rgba() calls was silently using its hardcoded dark-theme
  // fallback color regardless of the user's actual theme — including on
  // a light theme. This computes real RGB triplets from the live theme
  // and injects them as CSS custom properties so the fallbacks are only
  // ever a genuine last resort.
  const THEME_RGB_BASE_VARS = [
    '--vscode-button-background',
    '--vscode-charts-green',
    '--vscode-charts-purple',
    '--vscode-charts-red',
    '--vscode-editor-background',
    '--vscode-editorGroupHeader-tabsBackground',
    '--vscode-input-background',
    '--vscode-panel-border',
    '--vscode-sideBar-background',
    '--vscode-textLink-foreground',
  ];

  function parseColorToRgb(colorStr) {
    if (!colorStr) return null;
    colorStr = colorStr.trim();
    let m = colorStr.match(/^#([0-9a-fA-F]{3})$/);
    if (m) {
      return m[1].split('').map(c => parseInt(c + c, 16));
    }
    m = colorStr.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
    if (m) {
      const hex = m[1];
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
    m = colorStr.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
      return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
    }
    return null;
  }

  function updateThemeRgbVariables() {
    const computed = getComputedStyle(document.documentElement);
    const rootStyle = document.documentElement.style;
    THEME_RGB_BASE_VARS.forEach(baseVar => {
      const raw = computed.getPropertyValue(baseVar);
      const rgb = parseColorToRgb(raw);
      if (rgb) {
        rootStyle.setProperty(baseVar + '-rgb', rgb.join(','));
      }
    });
  }

  updateThemeRgbVariables();
  // VS Code toggles a vscode-light/vscode-dark/vscode-high-contrast class
  // on <body> when the user switches themes live — recompute when that happens.
  if (document.body) {
    new MutationObserver(updateThemeRgbVariables).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  const md = window.markdownit ? window.markdownit({ html: false, linkify: true, typographer: true }) : { render: (s) => `<p>${s.replace(/\n/g, '</p><p>')}</p>` };
  const chatHistory = document.getElementById('chat-history');
  const promptInput = document.getElementById('prompt-input');
  const sendBtn = document.getElementById('send-btn');
  const statusText = document.getElementById('status-text');
  const historyBtn = document.getElementById('history-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const closeHistoryBtn = document.getElementById('close-history');
  const historyPanel = document.getElementById('history-panel');
  const chatList = document.getElementById('chat-list');
  const suggestionList = document.getElementById('suggestion-list');
  const modelSelector = document.getElementById('model-selector');
  const attachBtn = document.getElementById('attach-btn');
  const attachmentChips = document.getElementById('attachment-chips');
  const artifactList = document.getElementById('artifact-list');
  const skillList = document.getElementById('skill-list');
  const timelineList = document.getElementById('timeline-list');
  const planList = document.getElementById('plan-list');
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  const modeBtnFast = document.getElementById('mode-fast');
  const modeBtnPlan = document.getElementById('mode-plan');

  let currentAssistantMessageId = null;
  let currentThoughtDiv = null;
  let isWaiting = false;
  /** Prompts typed while a turn is running — sent after current turn completes (Copilot/Antigravity-style). */
  let promptQueue = [];
  /** Agent Debug snapshot — declared early so the message handler never hits TDZ. */
  let lastAgentDebug = null;
  let attachedFiles = [];
  let currentMode = 'fast';
  let allTimelineEvents = [];
  let systemDiagnostics = [];

  const ICONS = {
    SEND: '<svg viewBox="0 0 16 16"><path d="M1.724 1.053a.5.5 0 0 0-.714.545l1.403 4.85a.5.5 0 0 0 .397.354l5.69.953c.268.053.268.437 0 .49l-5.69.953a.5.5 0 0 0-.397.354l-1.403 4.85a.5.5 0 0 0 .714.545l13-6.5a.5.5 0 0 0 0-.894l-13-6.5Z"/></svg>',
    STOP: '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
    APPLY: '<svg viewBox="0 0 16 16"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>',
    INSERT: '<svg viewBox="0 0 16 16"><path d="M1 2h2v2H1V2zm0 4h2v2H1V6zm0 4h2v2H1v-2zm4-8h10v2H5V2zm0 4h10v2H5V6zm0 4h6v2H5v-2z"/></svg>',
    COPY: '<svg viewBox="0 0 16 16"><path d="M4 4h8v1H4V4zm0 2h8v1H4V6zm0 2h5v1H4V8zm8-7H3L2 2v11l1 1h4v-1H3V2h8v1h1V2l-1-1zm2 4h-7l-1 1v8l1 1h7l1-1V6l-1-1zm0 9H6V6h7v9z"/></svg>',
    DIFF: '<svg viewBox="0 0 16 16"><path d="M6 3h4v2H6V3zm0 4h4v2H6V7zm0 4h4v2H6v-2zM2 3h3v2H2V3zm0 4h3v2H2V7zm0 4h3v2H2v-2zm9 0h3v2h-3v-2zm0-4h3v2h-3V7zm0-4h3v2h-3V3z"/></svg>',
    TRASH: '<svg viewBox="0 0 16 16"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 1 0-1.492.15l.66 6.623C3.844 14.555 4.805 16 6.002 16h3.996c1.197 0 2.158-1.445 2.338-2.552l.66-6.623a.75.75 0 0 0-1.492-.15l-.66 6.623a.853.853 0 0 1-.845.727H6.002a.853.853 0 0 1-.845-.727l-.66-6.623zM6.75 1.5h2.5v1.5h-2.5V1.5z"/></svg>',
    THOUGHT: '<svg viewBox="0 0 16 16"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zM4.5 7.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm3.5 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm3.5 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>',
    FILE: '<svg viewBox="0 0 16 16"><path d="M4 1.75V14h8V4.75L9.25 1.75H4zM3.25 0h6a.75.75 0 0 1 .53.22l3.5 3.5a.75.75 0 0 1 .22.53v10.5A1.25 1.25 0 0 1 12.25 16H3.75A1.25 1.25 0 0 1 2.5 14.75V1.25C2.5.56 3.06 0 3.75 0h-.5z"/></svg>',
    CHECK: '<svg viewBox="0 0 16 16"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>',
    CLOSE: '<svg viewBox="0 0 16 16"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/></svg>',
    EDIT: '<svg viewBox="0 0 16 16"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25a1.75 1.75 0 0 1 .445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.189 6.25l-1.44-1.44L3.083 11.477a.25.25 0 0 0-.064.108l-.446 1.564 1.564-.446a.25.25 0 0 0 .108-.064L11.189 6.25Z"/></svg>',
    SKILL: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 9.27a3.25 3.25 0 0 0-3.47-8.752L4.5 7.022a5.045 5.045 0 0 0-4.624 3.2 5.052 5.052 0 0 0 1.352 2.766l2.128-2.128a.75.75 0 0 1 1.06 1.06l-2.127 2.129A5.05 5.05 0 0 0 5.28 15.4c.94.417 1.954.542 2.92.368L14.7 9.27zM7.222 8.444L11.23 4.437a1.75 1.75 0 1 1 2.474 2.475l-4.007 4.007-2.475-2.475z"/></svg>',
    DISLIKE: '<svg viewBox="0 0 16 16"><path d="M15.651 7.396l-3.25-5.25A1 1 0 0 0 11.539 1.5H5a2 2 0 0 0-2 2v7a2 2 0 0 0 1.332 1.882l2.736 2.736A1.5 1.5 0 0 0 9.232 13H11.5a1.5 1.5 0 0 0 1.5-1.5v-1h.5a1.5 1.5 0 0 0 1.5-1.5V7.5a1 1 0 0 0-.349-.104zM12 11.5a.5.5 0 0 1-.5.5H9.232a.5.5 0 0 1-.354-.146L6.142 9.118A1 1 0 0 0 5 9V3.5a1 1 0 0 1 1-1h5.539l2.786 4.5H13.5a.5.5 0 0 1-.5.5v4zM1 3.5h1v8H1z"/></svg>',
    LIKE: '<svg viewBox="0 0 16 16"><path d="M.349 8.604l3.25 5.25a1 1 0 0 0 .862.646H11a2 2 0 0 0 2-2v-7a2 2 0 0 0-1.332-1.882L8.932.882A1.5 1.5 0 0 0 6.768 3H4.5A1.5 1.5 0 0 0 3 4.5v1h-.5a1.5 1.5 0 0 0-1.5 1.5V8.5a1 1 0 0 0 .349.104zM4 4.5a.5.5 0 0 1 .5-.5h2.268a.5.5 0 0 1 .354.146l2.736 2.736A1 1 0 0 0 11 7v5.5a1 1 0 0 1-1 1H4.461l-2.786-4.5H2.5a.5.5 0 0 1 .5-.5v-4zM15 12.5h-1v-8h1z"/></svg>'
  };

  function scrollBottom() {
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }

  /** When true, the next setWaiting(false) will not auto-run the prompt queue (used after Stop). */
  let suppressQueueFlushOnce = false;
  /** After the first auto-run from the queue, further items require confirm. */
  let queueNeedsConfirm = false;

  function setWaiting(waiting) {
    isWaiting = waiting;
    sendBtn.innerHTML = waiting ? ICONS.STOP : ICONS.SEND;
    sendBtn.classList.toggle('stop', waiting);
    if (!waiting) {
      if (!statusText.innerText || /thinking|refining|preparing|stopped/i.test(statusText.innerText)) {
        statusText.innerText = promptQueue.length
          ? `Queue: ${promptQueue.length} waiting`
          : '';
      }
      if (suppressQueueFlushOnce) {
        suppressQueueFlushOnce = false;
        renderQueueBadge();
        return;
      }
      if (promptQueue.length === 0) {
        queueNeedsConfirm = false;
        return;
      }
      // First queued message after a turn runs automatically; later ones ask
      if (!queueNeedsConfirm) {
        queueNeedsConfirm = true;
        flushPromptQueue();
      } else {
        offerNextQueuedConfirm();
      }
    }
  }

  function renderQueueBadge() {
    let badge = document.getElementById('prompt-queue-badge');
    if (promptQueue.length === 0) {
      if (badge) {
        badge.remove();
      }
      const bar = document.getElementById('queue-confirm-bar');
      if (bar) {
        bar.remove();
      }
      return;
    }
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'prompt-queue-badge';
      badge.className = 'prompt-queue-badge';
      const inputOuter = document.getElementById('input-outer');
      if (inputOuter) {
        inputOuter.insertBefore(badge, inputOuter.firstChild);
      }
    }
    const lines = promptQueue
      .map((item, i) => {
        const preview = truncateQueuePreview(item.text, i === 0 ? 160 : 80);
        const label = i === 0 ? 'Next' : `#${i + 1}`;
        return `<div class="queue-item"><span class="queue-item-label">${label}</span><span class="queue-item-text" title="${escapeHtml(item.text)}">${escapeHtml(preview)}</span></div>`;
      })
      .join('');
    badge.innerHTML =
      `<div class="queue-badge-header"><span>Queue (${promptQueue.length})</span>` +
      `<button type="button" class="queue-clear" title="Clear queue">×</button></div>` +
      `<div class="queue-items">${lines}</div>`;
    badge.querySelector('.queue-clear').onclick = () => {
      promptQueue = [];
      queueNeedsConfirm = false;
      renderQueueBadge();
      const bar = document.getElementById('queue-confirm-bar');
      if (bar) {
        bar.remove();
      }
      if (!isWaiting) {
        statusText.innerText = '';
      }
    };
  }

  /** Special @ tokens that are context scopes, not files — never render as file tags. */
  function isFileOrFolderMention(path) {
    const p = String(path || '').replace(/\/+$/, '').toLowerCase();
    if (!p) {
      return false;
    }
    if (p === 'workspace' || p === 'web' || p === 'codebase' || p === 'project') {
      return false;
    }
    return true;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function truncateQueuePreview(text, max) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) {
      return t;
    }
    return t.slice(0, max - 1) + '…';
  }

  function runQueuedItem(item) {
    if (!item || isWaiting) {
      return;
    }
    createMessage('user', item.text);
    setWaiting(true);
    currentAssistantMessageId = createMessage('assistant');
    currentThoughtDiv = null;
    vscode.postMessage({
      type: 'prompt',
      value: item.text,
      attachments: item.attachments || [],
    });
  }

  function flushPromptQueue() {
    if (isWaiting || promptQueue.length === 0) {
      return;
    }
    // First queued item runs automatically; further items need confirm
    const next = promptQueue.shift();
    renderQueueBadge();
    if (!next) {
      return;
    }
    if (promptQueue.length === 0) {
      runQueuedItem(next);
      return;
    }
    // More remain after this one — still run first without extra confirm
    runQueuedItem(next);
  }

  /**
   * After a turn completes, if more than one was originally conceptually
   * "stacked", ask before running each subsequent item.
   */
  function offerNextQueuedConfirm() {
    if (isWaiting || promptQueue.length === 0) {
      return;
    }
    const next = promptQueue[0];
    const preview = truncateQueuePreview(next.text, 120);
    const remaining = promptQueue.length;
    let bar = document.getElementById('queue-confirm-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'queue-confirm-bar';
      bar.className = 'queue-confirm-bar';
      const inputOuter = document.getElementById('input-outer');
      if (inputOuter) {
        inputOuter.insertBefore(bar, inputOuter.firstChild);
      }
    }
    bar.innerHTML =
      `<div class="queue-confirm-text"><strong>Send next queued?</strong> ` +
      `<span class="queue-confirm-preview">“${escapeHtml(preview)}”</span>` +
      (remaining > 1 ? ` <span class="queue-confirm-more">(+${remaining - 1} more)</span>` : '') +
      `</div>` +
      `<div class="queue-confirm-actions">` +
      `<button type="button" class="queue-confirm-yes">Send</button>` +
      `<button type="button" class="queue-confirm-skip">Skip</button>` +
      `<button type="button" class="queue-confirm-clear">Clear all</button>` +
      `</div>`;
    bar.querySelector('.queue-confirm-yes').onclick = () => {
      bar.remove();
      const item = promptQueue.shift();
      renderQueueBadge();
      runQueuedItem(item);
    };
    bar.querySelector('.queue-confirm-skip').onclick = () => {
      promptQueue.shift();
      renderQueueBadge();
      if (promptQueue.length === 0) {
        bar.remove();
      } else {
        offerNextQueuedConfirm();
      }
    };
    bar.querySelector('.queue-confirm-clear').onclick = () => {
      promptQueue = [];
      queueNeedsConfirm = false;
      renderQueueBadge();
      bar.remove();
      statusText.innerText = '';
    };
  }

  /** True only for paths that look like real files/folders (avoid tagging @word). */
  function looksLikeFilePath(filePath) {
    if (!isFileOrFolderMention(filePath)) {
      return false;
    }
    const p = String(filePath).replace(/\\/g, '/');
    if (p.includes('/')) {
      return true;
    }
    // basename with extension, e.g. main.ts, README.md
    if (/\.[a-zA-Z0-9]{1,8}$/.test(p)) {
      return true;
    }
    return false;
  }

  function formatMentions(html) {
    if (!html) return html;

    // Do not tag inside code/pre blocks (markdown output)
    const parts = String(html).split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/gi);
    for (let i = 0; i < parts.length; i++) {
      if (/^<(pre|code)/i.test(parts[i])) {
        continue;
      }
      parts[i] = parts[i].replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z0-9_\-\.\/\\]+)/g, (match, prefix, filePath) => {
        if (!looksLikeFilePath(filePath)) {
          return match;
        }
        const normalized = filePath.replace(/\\/g, '/');
        const partsPath = normalized.split('/');
        const basename = partsPath[partsPath.length - 1] || normalized;
        const isFolder = normalized.endsWith('/');
        const icon = isFolder ? '📁' : '📄';
        const safePath = normalized.replace(/"/g, '&quot;');
        const safeName = basename.replace(/\/$/, '').replace(/</g, '&lt;');
        return `${prefix}<span class="file-tag file-tag-clickable" data-path="${safePath}" title="Open ${safePath}" role="button" tabindex="0"><span class="file-tag-icon">${icon}</span><span class="file-tag-name">${safeName}</span></span>`;
      });
    }
    return parts.join('');
  }

  function openMentionPath(pathAttr) {
    if (!pathAttr || !isFileOrFolderMention(pathAttr)) {
      return;
    }
    const p = pathAttr.replace(/\\/g, '/');
    // Absolute paths → openAbsoluteFile; otherwise relative workspace path
    if (p.match(/^[a-zA-Z]:\//) || p.startsWith('/')) {
      vscode.postMessage({ type: 'openAbsoluteFile', value: p });
    } else {
      vscode.postMessage({ type: 'openFile', value: p });
    }
  }

  // Click file tags in chat history (and future dynamic content)
  if (chatHistory) {
    chatHistory.addEventListener('click', (e) => {
      const tag = e.target.closest && e.target.closest('.file-tag-clickable');
      if (tag) {
        e.preventDefault();
        openMentionPath(tag.getAttribute('data-path'));
      }
    });
  }

  function createMessage(role, content = '') {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;

    const header = document.createElement('div');
    header.className = 'message-header';
    header.innerText = role === 'user' ? 'You' : 'CodePartner';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    if (Array.isArray(content)) {
      content.forEach(part => {
        if (part.type === 'text') {
          const textSpan = document.createElement('div');
          let text = part.text;
          // Hide context from UI but keep in history string
          if (text.includes('--- Context ---') && text.includes('User Question:')) {
            text = text.split('User Question:').pop().trim();
          }
          textSpan.innerHTML = formatMentions(md.render(text));
          contentDiv.appendChild(textSpan);
        } else if (part.type === 'image_url') {
          const img = document.createElement('img');
          img.src = part.image_url.url;
          img.style.maxWidth = '100%';
          img.style.borderRadius = '4px';
          img.style.marginTop = '8px';
          contentDiv.appendChild(img);
        }
      });
    } else if (typeof content === 'string' && content) {
      let text = content;
      if (text.includes('--- Context ---') && text.includes('User Question:')) {
        text = text.split('User Question:').pop().trim();
      }
      contentDiv.innerHTML = formatMentions(md.render(text));
    } else {
      contentDiv.innerHTML = content || (role === 'assistant' ? '<div class="spinner"></div>' : '');
    }

    messageDiv.appendChild(header);
    messageDiv.appendChild(contentDiv);

    chatHistory.appendChild(messageDiv);
    scrollBottom();
    return contentDiv;
  }

  function addFeedbackRow(container, content) {
    if (!container) return;

    // Remove previous feedback rows - only newest assistant message should have it
    const oldFeedbacks = chatHistory.querySelectorAll('.feedback-row');
    oldFeedbacks.forEach(f => f.remove());

    const feedbackRow = document.createElement('div');
    feedbackRow.className = 'feedback-row';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'feedback-toggle';
    toggle.title = 'Rate this response';
    toggle.textContent = 'Feedback ▸';
    toggle.setAttribute('aria-expanded', 'false');

    const panel = document.createElement('div');
    panel.className = 'feedback-panel collapsed';

    const buttons = document.createElement('div');
    buttons.className = 'feedback-buttons';

    const feedbackInputContainer = document.createElement('div');
    feedbackInputContainer.className = 'feedback-input-wrap hidden';

    const likeBtn = document.createElement('button');
    likeBtn.className = 'icon-btn';
    likeBtn.title = 'Helpful';
    likeBtn.innerHTML = ICONS.LIKE;
    likeBtn.onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'feedback', value: 'positive', content: content });
      feedbackRow.remove();
    };

    const dislikeBtn = document.createElement('button');
    dislikeBtn.className = 'icon-btn';
    dislikeBtn.title = 'Not helpful';
    dislikeBtn.innerHTML = ICONS.DISLIKE;
    dislikeBtn.onclick = (e) => {
      e.stopPropagation();
      dislikeBtn.style.color = 'var(--vscode-charts-red)';
      dislikeBtn.style.opacity = '1';
      likeBtn.style.opacity = '0.6';
      feedbackInputContainer.classList.remove('hidden');
      feedbackInput.focus();
    };

    const feedbackInput = document.createElement('input');
    feedbackInput.placeholder = 'What was wrong? (optional)';
    feedbackInput.className = 'skill-form-input feedback-detail-input';
    feedbackInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        vscode.postMessage({ type: 'feedback', value: 'negative', detail: feedbackInput.value, content: content });
        feedbackInputContainer.innerHTML = '<span class="feedback-thanks">Thanks for the feedback!</span>';
        setTimeout(() => feedbackRow.remove(), 2000);
      }
    };

    toggle.onclick = (e) => {
      e.stopPropagation();
      const collapsed = panel.classList.contains('collapsed');
      if (collapsed) {
        panel.classList.remove('collapsed');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.textContent = 'Feedback ▾';
      } else {
        panel.classList.add('collapsed');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'Feedback ▸';
      }
    };

    feedbackInputContainer.appendChild(feedbackInput);
    buttons.append(likeBtn, dislikeBtn);
    panel.append(buttons, feedbackInputContainer);
    feedbackRow.append(toggle, panel);
    // Append inside the message card so layout doesn't overflow the sidebar
    const host = container.closest('.message') || container.parentElement || container;
    host.appendChild(feedbackRow);
  }

  function createThoughtBlock(container) {
    const thoughtContainer = document.createElement('div');
    thoughtContainer.className = 'thought-container';

    const header = document.createElement('div');
    header.className = 'thought-header';
    header.innerHTML = `${ICONS.THOUGHT} <span>Thinking...</span> <span class="collapse-icon">▼</span>`;
    header.onclick = () => {
      header.classList.toggle('collapsed');
      content.classList.toggle('collapsed');
    };

    const content = document.createElement('div');
    content.className = 'thought-content';

    thoughtContainer.appendChild(header);
    thoughtContainer.appendChild(content);
    container.appendChild(thoughtContainer);
    return content;
  }

  function renderModifiedFiles(files, container) {
    let existingFiles = container.querySelector('.modified-files-container');
    if (!existingFiles) {
      existingFiles = document.createElement('div');
      existingFiles.className = 'modified-files-container';
      existingFiles.innerHTML = `<div class="modified-files-header">${ICONS.FILE} <span>Review Changes</span></div><div class="modified-files-list"></div>`;
      container.appendChild(existingFiles);
    }

    const list = existingFiles.querySelector('.modified-files-list');
    list.innerHTML = '';
    files.forEach(file => {
      const row = document.createElement('div');
      row.className = 'file-row';

      const info = document.createElement('div');
      info.className = 'file-info';

      const name = document.createElement('div');
      name.className = 'file-name';
      name.innerText = file.path;
      name.title = 'View Diff';
      name.onclick = () => vscode.postMessage({ type: 'showDiff', value: file.path });

      const stats = document.createElement('div');
      stats.className = 'file-stats';
      if (file.added > 0) {
        stats.innerHTML += `<span class="stat-add">+${file.added}</span>`;
      }
      if (file.removed > 0) {
        stats.innerHTML += `<span class="stat-rem">-${file.removed}</span>`;
      }

      info.append(name, stats);

      const actions = document.createElement('div');
      actions.className = 'file-actions';

      const approveBtn = document.createElement('button');
      approveBtn.className = 'action-btn approve';
      approveBtn.innerHTML = ICONS.CHECK;
      approveBtn.title = 'Approve (Keep)';
      approveBtn.onclick = () => vscode.postMessage({ type: 'approveChanges', value: file.path });

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'action-btn reject';
      rejectBtn.innerHTML = ICONS.CLOSE;
      rejectBtn.title = 'Reject (Revert)';
      rejectBtn.onclick = () => vscode.postMessage({ type: 'rejectChanges', value: file.path });

      actions.append(approveBtn, rejectBtn);
      row.append(info, actions);
      list.appendChild(row);
    });
  }

  function renderChatList(chats) {
    chatList.innerHTML = '';
    chats.forEach(chat => {
      const item = document.createElement('div');
      item.className = 'chat-item';

      const contentRow = document.createElement('div');
      contentRow.className = 'chat-item-content-row';
      contentRow.style.display = 'flex';
      contentRow.style.justifyContent = 'space-between';
      contentRow.style.alignItems = 'flex-start';

      const title = document.createElement('div');
      title.className = 'chat-item-title';
      title.innerText = chat.title || 'Untitled Chat';

      const actions = document.createElement('div');
      actions.className = 'chat-item-actions';
      actions.style.display = 'flex';
      actions.style.gap = '4px';

      const renameBtn = document.createElement('button');
      renameBtn.className = 'icon-btn';
      renameBtn.innerHTML = ICONS.EDIT;
      renameBtn.title = 'Rename chat';
      renameBtn.onclick = (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.type = 'text';
        input.value = chat.title || '';
        input.className = 'rename-input';
        input.style.width = '100%';
        input.style.background = 'var(--vscode-input-background)';
        input.style.color = 'var(--vscode-input-foreground)';
        input.style.border = '1px solid var(--vscode-focusBorder)';

        const saveRename = () => {
          const newTitle = input.value.trim();
          if (newTitle && newTitle !== chat.title) {
            vscode.postMessage({ type: 'renameChat', chatId: chat.id, title: newTitle });
            title.innerText = newTitle;
          }
          input.replaceWith(title);
        };

        input.onkeydown = (e) => {
          if (e.key === 'Enter') {
            saveRename();
          }
          if (e.key === 'Escape') {
            input.replaceWith(title);
          }
        };
        input.onblur = saveRename;

        title.replaceWith(input);
        input.focus();
        input.select();
      };

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'icon-btn';
      deleteBtn.innerHTML = ICONS.TRASH;
      deleteBtn.title = 'Delete chat';
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteChat', value: chat.id });
      };

      item.onclick = () => {
        vscode.postMessage({ type: 'loadChat', value: chat.id });
        historyPanel.classList.add('hidden');
      };

      const meta = document.createElement('div');
      meta.className = 'chat-item-meta';
      meta.innerText = new Date(chat.timestamp).toLocaleString();

      actions.append(renameBtn, deleteBtn);
      contentRow.append(title, actions);
      item.append(contentRow, meta);
      chatList.appendChild(item);
    });
    scrollBottom();
  }

  // --- Suggestions handling ---
  let selectedSuggestionIndex = -1;
  let currentSuggestions = [];

  function showSuggestions(suggestions) {
    currentSuggestions = suggestions;
    if (suggestions.length === 0) {
      suggestionList.classList.add('hidden');
      return;
    }

    suggestionList.innerHTML = '';
    suggestions.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'suggestion-item';
      if (i === selectedSuggestionIndex) {
        item.classList.add('selected');
      }

      const label = document.createElement('div');
      label.className = 'suggestion-label';
      label.innerText = s.label;

      const detail = document.createElement('div');
      detail.className = 'suggestion-detail';
      detail.innerText = s.detail;

      item.onclick = () => {
        selectSuggestion(s);
      };
      item.append(label, detail);
      suggestionList.appendChild(item);
    });

    suggestionList.classList.remove('hidden');
  }

  function selectSuggestion(suggestion) {
    const val = promptInput.value;
    const pos = promptInput.selectionStart;
    
    const isSlash = suggestion.label.startsWith('/');
    const charToFind = isSlash ? '/' : '@';
    const lastChar = val.lastIndexOf(charToFind, pos - 1);

    if (lastChar !== -1) {
      const before = val.slice(0, lastChar);
      const after = val.slice(pos);
      promptInput.value = before + suggestion.label + (suggestion.type === 'folder' ? '' : ' ') + after;
      promptInput.selectionStart = promptInput.selectionEnd = lastChar + suggestion.label.length + (suggestion.type === 'folder' ? 0 : 1);
      syncOverlay();
    }

    suggestionList.classList.add('hidden');
    selectedSuggestionIndex = -1;
    promptInput.focus();
  }

  function updateModels(models, selected) {
    modelSelector.innerHTML = '';
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      // Phase 4.5: show context window size next to the name, where known,
      // instead of just a bare model name.
      opt.innerText = (m.name || m.id) + (m.contextWindowLabel ? ' (' + m.contextWindowLabel + ')' : '');
      if (m.contextWindow) {
        opt.title = 'Context window: ' + m.contextWindow.toLocaleString() + ' tokens';
      }
      if (m.id === selected) {
        opt.selected = true;
      }
      modelSelector.appendChild(opt);
    });
  }

  function loadMessages(messages) {
    chatHistory.innerHTML = '';
    currentAssistantMessageId = null;
    currentThoughtDiv = null;
    statusText.innerText = '';
    setWaiting(false);
    promptQueue = [];
    renderQueueBadge();

    (messages || []).forEach(m => {
      if (m.role === 'system' || m.hiddenFromUI) {
        return;
      }
      let body = m.content;
      if (typeof body === 'string') {
        if (body.includes('--- Context ---') && body.includes('User Question:')) {
          body = body.split('User Question:').pop().trim();
        }
        if (/^(Preparing context|Thinking|Refining|Stopped)\.\.\.?$/i.test(body.trim())) {
          return;
        }
        if (!body.trim()) {
          return;
        }
      }
      const content = createMessage(m.role, body);
      processCodeBlocks(content, m.role === 'assistant');
    });
    scrollBottom();
  }

  function renderAttachmentChips() {
    if (attachedFiles.length === 0) {
      attachmentChips.classList.add('hidden');
      attachmentChips.innerHTML = '';
      return;
    }

    attachmentChips.classList.remove('hidden');
    attachmentChips.innerHTML = '';
    attachedFiles.forEach((file, index) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';

      const name = document.createElement('span');
      name.innerText = file.name;

      const removeBtn = document.createElement('div');
      removeBtn.className = 'remove-btn';
      removeBtn.innerHTML = ICONS.CLOSE;
      removeBtn.onclick = () => {
        attachedFiles.splice(index, 1);
        renderAttachmentChips();
      };

      chip.append(name, removeBtn);
      attachmentChips.appendChild(chip);
    });
  }

  // Mode toggle
  const modeBtns = document.querySelectorAll('.mode-btn');
  modeBtns.forEach(btn => {
    btn.onclick = () => {
      modeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      vscode.postMessage({ type: 'changeMode', value: btn.id.replace('mode-', '') });
    };
  });

  const architectDraftsContainer = document.getElementById('architect-drafts');
  const draftsList = document.getElementById('drafts-list');
  document.getElementById('apply-drafts-btn').onclick = () => {
    vscode.postMessage({ type: 'applyArchitectDrafts' });
  };
  const applyHunksBtn = document.getElementById('apply-hunks-btn');
  if (applyHunksBtn) {
    applyHunksBtn.onclick = () => {
      vscode.postMessage({ type: 'applyArchitectHunks', value: collectAcceptedHunkSelections() });
    };
  }
  const clearDiagnosticsBtn = document.getElementById('clear-diagnostics-btn');
  if (clearDiagnosticsBtn) {
    clearDiagnosticsBtn.onclick = () => {
      vscode.postMessage({ type: 'clearDiagnostics' });
    };
  }
  const openDebugLogBtn = document.getElementById('open-debug-log-btn');
  if (openDebugLogBtn) {
    openDebugLogBtn.onclick = () => {
      vscode.postMessage({ type: 'openDebugLog' });
    };
  }
  const refreshDebugBtn = document.getElementById('refresh-debug-btn');
  if (refreshDebugBtn) {
    refreshDebugBtn.onclick = () => {
      vscode.postMessage({ type: 'requestAgentDebug' });
    };
  }

  // UI Event Listeners
  // Navbar overflow menu (narrow sidebars collapse History / Feedback / New chat into ⋯)
  (function wireHeaderMoreMenu() {
    const moreBtn = document.getElementById('header-more-btn');
    const moreMenu = document.getElementById('header-more-menu');
    if (!moreBtn || !moreMenu) {
      return;
    }
    const closeMenu = () => {
      moreMenu.classList.add('hidden');
      moreBtn.setAttribute('aria-expanded', 'false');
    };
    moreBtn.onclick = (e) => {
      e.stopPropagation();
      const open = moreMenu.classList.toggle('hidden') === false;
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    moreMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.header-more-item');
      if (!item) {
        return;
      }
      const action = item.getAttribute('data-action');
      closeMenu();
      if (action === 'history' && historyBtn) {
        historyBtn.click();
      } else if (action === 'feedback') {
        const fb = document.getElementById('feedback-btn');
        if (fb) {
          fb.click();
        }
      } else if (action === 'new-chat' && newChatBtn) {
        newChatBtn.click();
      }
    });
    document.addEventListener('click', (e) => {
      if (!moreMenu.classList.contains('hidden') && !moreMenu.contains(e.target) && e.target !== moreBtn) {
        closeMenu();
      }
    });
  })();

  historyBtn.onclick = () => {
    vscode.postMessage({ type: 'listChats' });
    historyPanel.classList.remove('hidden');
  };

  closeHistoryBtn.onclick = () => {
    historyPanel.classList.add('hidden');
  };

  newChatBtn.onclick = () => {
    vscode.postMessage({ type: 'clearChat' });
  };

  const feedbackBtn = document.getElementById('feedback-btn');
  if (feedbackBtn) {
    feedbackBtn.onclick = () => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
  
      const modal = document.createElement('div');
      modal.className = 'modal-content';
  
      modal.innerHTML = `
        <div class="modal-header">
          <div style="background:var(--accent-dim); color:var(--accent); padding:4px; border-radius:6px; display:flex;">${ICONS.FILE}</div>
          <div class="modal-title">Send Feedback / Report Bug</div>
          <button class="icon-btn modal-close" id="close-modal-btn">${ICONS.CLOSE}</button>
        </div>
        <div style="display:flex; flex-direction:column; gap:12px;">
          <div>
            <label style="display:block; font-size:11px; opacity:0.7; margin-bottom:4px;">Feedback Type</label>
            <select id="feedback-type" class="skill-form-input">
              <option value="Bug">🐞 Report a Bug</option>
              <option value="Improvement">✨ Suggest Improvement</option>
              <option value="Feature">💡 Feature Request</option>
              <option value="Other">❓ Other</option>
            </select>
          </div>
          <div>
            <label style="display:block; font-size:11px; opacity:0.7; margin-bottom:4px;">Description</label>
            <textarea id="feedback-desc" class="skill-form-textarea" placeholder="Tell us more..." style="min-height:100px;"></textarea>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" id="include-code" style="cursor:pointer;">
            <label for="include-code" style="font-size:11px; opacity:0.9; cursor:pointer;">Attach current file code</label>
          </div>
          <div class="modal-footer" style="display:flex; justify-content:flex-end; gap:10px; margin-top:8px;">
            <button id="cancel-feedback-btn" class="skill-cancel-btn">Cancel</button>
            <button id="send-feedback-btn" class="skill-save-btn">Send via Email</button>
          </div>
        </div>
      `;
  
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
  
      const closeModal = () => overlay.remove();
      overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
      modal.querySelector('#close-modal-btn').onclick = closeModal;
      modal.querySelector('#cancel-feedback-btn').onclick = closeModal;
  
      modal.querySelector('#send-feedback-btn').onclick = () => {
        const feedbackType = modal.querySelector('#feedback-type').value;
        const desc = modal.querySelector('#feedback-desc').value.trim();
        const includeCode = modal.querySelector('#include-code').checked;
  
        if (desc) {
          vscode.postMessage({
            type: 'submitFeedback',
            feedbackType: feedbackType,
            description: desc,
            includeCode: includeCode
          });
          closeModal();
        } else {
          modal.querySelector('#feedback-desc').style.borderColor = 'var(--vscode-errorForeground)';
        }
      };
    };
  }

  function insertTag(tag) {
    const pos = promptInput.selectionStart;
    const val = promptInput.value;
    promptInput.value = val.slice(0, pos) + tag + val.slice(pos);
    promptInput.focus();
    promptInput.selectionStart = promptInput.selectionEnd = pos + tag.length;
  }

  // --- Tab Management ---
  tabBtns.forEach(btn => {
    btn.onclick = () => {
      const targetTab = btn.getAttribute('data-tab');
      tabBtns.forEach(b => b.classList.toggle('active', b === btn));
      tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${targetTab}`));
    };
  });

  function renderPlan(tasks) {
    if (!planList) return;
    planList.innerHTML = '';
    if (!tasks || tasks.length === 0) {
      planList.innerHTML = '<div class="empty-state">No active plan. Use Planning mode for complex tasks.</div>';
      // Remove progress bar if exists
      const existingProgress = document.querySelector('.plan-progress-bar-container');
      if (existingProgress) existingProgress.remove();
      return;
    }

    // Progress bar
    const doneCount = tasks.filter(t => t.done).length;
    const percent = Math.round((doneCount / tasks.length) * 100);
    const progressEl = document.querySelector('.plan-progress');
    if (progressEl) progressEl.textContent = `${doneCount}/${tasks.length}`;

    // Add/update progress bar above the list
    let progressContainer = document.querySelector('.plan-progress-bar-container');
    if (!progressContainer) {
      progressContainer = document.createElement('div');
      progressContainer.className = 'plan-progress-bar-container';
      planList.parentElement.insertBefore(progressContainer, planList);
    }
    progressContainer.innerHTML = `
      <div class="plan-progress-bar">
        <div class="plan-progress-bar-fill" style="width: ${percent}%"></div>
      </div>
      <div class="plan-progress-text">${doneCount} of ${tasks.length} complete (${percent}%)</div>
    `;

    tasks.forEach((taskObj, index) => {
      const task = typeof taskObj === 'string' ? taskObj : taskObj.task;
      const isDone = taskObj.done || false;

      const item = document.createElement('div');
      item.className = 'plan-item';
      if (isDone) item.style.opacity = '0.6';
      item.id = `plan-task-${index}`;

      const checkbox = document.createElement('div');
      checkbox.className = `plan-checkbox${isDone ? ' done' : ''}`;
      checkbox.onclick = () => { if (!checkbox.classList.contains('done')) completeTask(index); };

      const text = document.createElement('div');
      text.className = 'plan-text';

      const mentionRegex = /@([a-zA-Z0-9_\-./\\]+)/g;
      let hasLink = false, firstLink = '';
      const matches = [...task.matchAll(mentionRegex)];
      let html = '', lastEnd = 0;
      matches.forEach(match => {
        html += task.slice(lastEnd, match.index);
        html += `<span class="plan-mention">${match[0]}</span>`;
        if (!hasLink) { hasLink = true; firstLink = match[1]; }
        lastEnd = match.index + match[0].length;
      });
      html += task.slice(lastEnd);
      text.innerHTML = html;

      item.appendChild(checkbox);
      item.appendChild(text);

      if (hasLink) {
        const openBtn = document.createElement('button');
        openBtn.className = 'plan-open-btn icon-btn';
        openBtn.innerHTML = ICONS.FILE;
        openBtn.title = `Open ${firstLink}`;
        openBtn.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'openFile', value: firstLink }); };
        item.appendChild(openBtn);
      }

      planList.appendChild(item);
    });

    // Auto-switch to plan tab when plan is received
    const planTabBtn = document.querySelector('[data-tab="plan"]');
    if (planTabBtn && tasks.length > 0) {
      planTabBtn.classList.add('has-content');
    }
  }

  function completeTask(index) {
    const item = document.getElementById(`plan-task-${index}`);
    if (item) {
      const checkbox = item.querySelector('.plan-checkbox');
      if (!checkbox.classList.contains('done')) {
        checkbox.classList.add('done');
        item.style.opacity = '0.7';
        vscode.postMessage({ type: 'completeTask', value: index });
      }
    }
  }

  function renderArtifact(art) {
    if (!artifactList) return;
    const empty = artifactList.querySelector('.empty-state');
    if (empty) artifactList.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'artifact-card';
    // Use openAbsoluteFile for absolute paths from ArtifactRegistry
    card.onclick = () => vscode.postMessage({ type: 'openAbsoluteFile', value: art.filePath });
    card.title = 'Click to open file';

    const badge = document.createElement('div');
    badge.className = 'artifact-type-badge';
    badge.innerText = art.type;

    const title = document.createElement('div');
    title.className = 'artifact-card-title';
    title.innerText = art.title;

    const pathDiv = document.createElement('div');
    pathDiv.className = 'artifact-card-path';
    pathDiv.innerText = art.filePath ? art.filePath.split(/[\\/]/).pop() : '';

    const meta = document.createElement('div');
    meta.className = 'artifact-card-meta';
    meta.innerText = new Date(art.timestamp).toLocaleTimeString();

    card.append(badge, title, pathDiv, meta);
    artifactList.prepend(card);
  }

  function renderArtifacts(artifacts) {
    if (!artifactList) return;
    artifactList.innerHTML = '';
    if (!artifacts || artifacts.length === 0) {
      artifactList.innerHTML = '<div class="empty-state">No artifacts generated yet.</div>';
      return;
    }
    artifacts.forEach(art => renderArtifact(art));
  }

  const promptOverlay = document.getElementById('prompt-overlay');

  function formatMentionsForOverlay(text) {
    if (!text) return '';
    // Visual highlight only — clicks go to the mention-chips bar (textarea sits on top of overlay)
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let formatted = escaped.replace(/(^|\s)@([a-zA-Z0-9_\-\.\/\\]+)/g, (match, prefix, filePath) => {
      if (!looksLikeFilePath(filePath)) {
        return match;
      }
      const normalized = filePath.replace(/\\/g, '/');
      const parts = normalized.split('/');
      const basename = parts[parts.length - 1] || normalized;
      const isFolder = normalized.endsWith('/');
      const icon = isFolder ? '📁' : '📄';
      const safeName = basename.replace(/\/$/, '');
      return `${prefix}<span class="file-tag"><span class="file-tag-icon">${icon}</span><span class="file-tag-name">${safeName}</span></span>`;
    });
    if (formatted.endsWith('\n')) formatted += '<br>';
    return formatted;
  }

  function extractFileMentions(text) {
    const found = [];
    const re = /(^|[\s])@([a-zA-Z0-9_\-\.\/\\]+)/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
      if (looksLikeFilePath(m[2])) {
        const n = m[2].replace(/\\/g, '/');
        if (!found.includes(n)) {
          found.push(n);
        }
      }
    }
    return found;
  }

  /** Remove @path from the prompt input (first match). */
  function removeMentionFromInput(filePath) {
    if (!promptInput || !filePath) {
      return;
    }
    const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[\\s])@' + escaped + '(?=[\\s]|$)');
    let next = promptInput.value.replace(re, (full, pre) => pre || '');
    // Also try with backslashes
    if (next === promptInput.value && filePath.includes('/')) {
      const alt = filePath.replace(/\//g, '\\\\');
      const re2 = new RegExp('(^|[\\s])@' + alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\s]|$)');
      next = promptInput.value.replace(re2, (full, pre) => pre || '');
    }
    next = next.replace(/[ \t]{2,}/g, ' ').replace(/^\s+/, '');
    promptInput.value = next;
    promptInput.focus();
    syncOverlay();
    renderMentionChips();
  }

  /**
   * Interactive mention chips ABOVE the textarea (textarea covers the overlay,
   * so overlay tags cannot receive clicks — this is the Copilot-style bar).
   */
  function renderMentionChips() {
    const inputOuter = document.getElementById('input-outer');
    const inputContainer = document.getElementById('input-container');
    if (!inputOuter || !inputContainer || !promptInput) {
      return;
    }
    let bar = document.getElementById('mention-chips');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'mention-chips';
      bar.className = 'mention-chips';
      inputOuter.insertBefore(bar, inputContainer);
      bar.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.file-tag-remove');
        if (removeBtn) {
          e.preventDefault();
          e.stopPropagation();
          const path = removeBtn.getAttribute('data-path') || removeBtn.closest('.file-tag')?.getAttribute('data-path');
          removeMentionFromInput(path);
          return;
        }
        const tag = e.target.closest('.file-tag-clickable');
        if (tag) {
          e.preventDefault();
          openMentionPath(tag.getAttribute('data-path'));
        }
      });
    }
    const mentions = extractFileMentions(promptInput.value);
    if (mentions.length === 0) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }
    bar.classList.remove('hidden');
    bar.innerHTML = mentions
      .map((filePath) => {
        const parts = filePath.split('/');
        const basename = parts[parts.length - 1] || filePath;
        const isFolder = filePath.endsWith('/');
        const icon = isFolder ? '📁' : '📄';
        const safePath = filePath.replace(/"/g, '&quot;');
        const safeName = basename.replace(/\/$/, '');
        return (
          `<span class="file-tag file-tag-clickable file-tag-removable" data-path="${safePath}" title="${safePath}">` +
          `<span class="file-tag-icon">${icon}</span>` +
          `<span class="file-tag-name">${safeName}</span>` +
          `<button type="button" class="file-tag-remove" data-path="${safePath}" title="Remove mention" aria-label="Remove">×</button>` +
          `</span>`
        );
      })
      .join('');
  }

  function syncOverlay() {
    if (!promptOverlay || !promptInput) return;
    promptOverlay.innerHTML = formatMentionsForOverlay(promptInput.value || '');
    promptOverlay.style.height = promptInput.style.height || '44px';
    promptOverlay.scrollTop = promptInput.scrollTop;
    renderMentionChips();
  }

  // Phase 3.7: debounce @/-mention suggestion requests instead of firing
  // one per keystroke — the backend now caches the file listing, but a
  // request still crosses the extension-host boundary and re-filters, so
  // there's no reason to fire one on every single character while typing
  // fast. Local UI feedback (resize, overlay sync, hiding the list) stays
  // synchronous; only the request to the backend is delayed.
  let suggestionsDebounceTimer = null;
  const SUGGESTIONS_DEBOUNCE_MS = 150;
  function requestSuggestionsDebounced(type, query) {
    clearTimeout(suggestionsDebounceTimer);
    suggestionsDebounceTimer = setTimeout(() => {
      vscode.postMessage({ type: 'getSuggestions', value: { type, query } });
    }, SUGGESTIONS_DEBOUNCE_MS);
  }

  // Handle Input Auto-resize and Suggestions
  promptInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
    syncOverlay();

    // Preserve cursor position (fixes cursor jumping bug with overlay/mentions)
    const cursorPos = this.selectionStart;
    // Force layout to ensure cursor position is correct after overlay sync
    void this.offsetWidth;
    this.selectionStart = cursorPos;
    this.selectionEnd = cursorPos;

    const pos = promptInput.selectionStart;
    const val = promptInput.value;
    const lastAt = val.lastIndexOf('@', pos - 1);
    const lastSlash = val.lastIndexOf('/', pos - 1);

    if (lastAt !== -1 && !val.slice(lastAt, pos).includes(' ') && lastAt >= lastSlash) {
      const query = val.slice(lastAt + 1, pos);
      requestSuggestionsDebounced('@', query);
    } else if (lastSlash !== -1 && !val.slice(lastSlash, pos).includes(' ') && lastSlash > lastAt) {
      const query = val.slice(lastSlash + 1, pos);
      requestSuggestionsDebounced('/', query);
    } else {
      clearTimeout(suggestionsDebounceTimer);
      suggestionList.classList.add('hidden');
    }
  });

  // Handle Enter Key and Navigation
  promptInput.addEventListener('scroll', function() {
    syncOverlay();
  });

  promptInput.addEventListener('keydown', (e) => {
    if (!suggestionList.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedSuggestionIndex = (selectedSuggestionIndex + 1) % currentSuggestions.length;
        showSuggestions(currentSuggestions);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedSuggestionIndex = (selectedSuggestionIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
        showSuggestions(currentSuggestions);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (selectedSuggestionIndex > -1) {
          e.preventDefault();
          selectSuggestion(currentSuggestions[selectedSuggestionIndex]);
        }
      } else if (e.key === 'Escape') {
        suggestionList.classList.add('hidden');
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  // Image paste support for chatbox
  promptInput.addEventListener('paste', (e) => {
    const items = (e.clipboardData || window.clipboardData)?.items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = (event) => {
            const base64 = event.target.result.toString().split(',')[1];
            const attached = [{
              name: `pasted-image-${Date.now()}.png`,
              mimeType: 'image/png',
              data: base64
            }];
            attachedFiles.push(...attached);
            renderAttachmentChips();
            statusText.innerText = '📎 Image pasted and attached!';
            setTimeout(() => { if (statusText) statusText.innerText = ''; }, 2500);
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    }
  });
  
  modelSelector.onchange = () => {
    vscode.postMessage({ type: 'changeModel', value: modelSelector.value });
  };

  attachBtn.onclick = () => {
    vscode.postMessage({ type: 'attachFiles' });
  };

  // Drag-and-drop file attachment: reuses the exact same attachedFiles
  // pipeline as the file picker / attachBtn above. Two cases, since a
  // browser drag event carries different data depending on the source:
  //  - Dragging a file in from the OS file manager: dataTransfer.files
  //    gives real File objects, readable client-side via FileReader.
  //  - Dragging a file from VS Code's own Explorer: it's an in-app drag,
  //    not a real filesystem drop, so dataTransfer only carries a
  //    text/uri-list — the extension host reads that file from disk
  //    (see the "attachFilesByPath" case in extension.ts).
  const dropZone = document.getElementById('input-outer');
  let dragDepth = 0;

  function readFileAsAttachment(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result || '';
        const commaIdx = dataUrl.indexOf(',');
        const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
        resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', data: base64 });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  let dropShiftHeld = false;

  function ensureDropOverlay() {
    if (!dropZone) return null;
    let overlay = document.getElementById('drop-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'drop-overlay';
      overlay.innerHTML =
        '<div class="drop-overlay-content">' +
        '<span class="drop-title">Drop files to attach</span>' +
        '<span class="drop-hint">Hold <kbd>Shift</kbd> while dragging, then release to drop</span>' +
        '</div>';
      dropZone.appendChild(overlay);
    }
    return overlay;
  }

  function updateDropOverlayMessage(shiftHeld) {
    const overlay = ensureDropOverlay();
    if (!overlay) return;
    const title = overlay.querySelector('.drop-title');
    const hint = overlay.querySelector('.drop-hint');
    if (shiftHeld) {
      if (title) title.textContent = 'Release to attach';
      if (hint) hint.innerHTML = 'Shift held — drop files now';
      overlay.classList.add('drop-ready');
    } else {
      if (title) title.textContent = 'Hold Shift to enable drop';
      if (hint) hint.innerHTML = 'VS Code requires <kbd>Shift</kbd> for drops into the chat';
      overlay.classList.remove('drop-ready');
    }
  }

  function showDropOverlay(show) {
    const overlay = ensureDropOverlay();
    if (overlay) overlay.classList.toggle('visible', show);
    if (dropZone) dropZone.classList.toggle('drag-over', show);
  }

  // Static tip under the input so users discover Shift without dragging first
  (function ensureDropHintChip() {
    const inputOuter = document.getElementById('input-outer');
    if (!inputOuter || document.getElementById('drop-hint-chip')) return;
    const chip = document.createElement('div');
    chip.id = 'drop-hint-chip';
    chip.className = 'drop-hint-chip';
    chip.innerHTML = 'Tip: hold <kbd>Shift</kbd> and drop files here to attach';
    inputOuter.appendChild(chip);
  })();

  if (dropZone) {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evt) => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });
    dropZone.addEventListener('dragenter', (e) => {
      dragDepth++;
      if (e.dataTransfer && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/uri-list'))) {
        dropShiftHeld = !!e.shiftKey;
        showDropOverlay(true);
        updateDropOverlayMessage(dropShiftHeld);
      }
    });
    dropZone.addEventListener('dragover', (e) => {
      dropShiftHeld = !!e.shiftKey;
      updateDropOverlayMessage(dropShiftHeld);
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = dropShiftHeld ? 'copy' : 'none';
      }
    });
    dropZone.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) showDropOverlay(false);
    });
    dropZone.addEventListener('drop', async (e) => {
      dragDepth = 0;
      showDropOverlay(false);
      const shiftOk = !!(e.shiftKey || dropShiftHeld);
      dropShiftHeld = false;

      const dt = e.dataTransfer;
      if (!dt) { return; }

      if (!shiftOk) {
        statusText.innerText = 'Hold Shift while dropping to attach files';
        return;
      }

      if (dt.files && dt.files.length > 0) {
        const results = await Promise.all(Array.from(dt.files).map(readFileAsAttachment));
        const valid = results.filter(Boolean);
        if (valid.length > 0) {
          attachedFiles.push(...valid);
          renderAttachmentChips();
          statusText.innerText = `Attached ${valid.length} file(s)`;
        }
        return;
      }

      const uriList = dt.getData('text/uri-list');
      if (uriList) {
        const uris = uriList.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        if (uris.length > 0) {
          vscode.postMessage({ type: 'attachFilesByPath', value: uris });
        }
      }
    });
  }

  // Mention interactions live on #mention-chips (textarea covers #prompt-overlay)

  // Handle Send/Stop click
  sendBtn.addEventListener('click', () => {
    if (isWaiting) {
      // Stop immediately in the UI; extension cancels tools/stream.
      // Do not call setWaiting(false) here in a way that flushes the queue
      // before the user sees "Stopped" — cancel posts `done`, which clears
      // waiting; we suppress queue flush for pure stop via a flag.
      suppressQueueFlushOnce = true;
      vscode.postMessage({ type: 'cancel' });
      setWaiting(false);
      statusText.innerText = 'Stopped.';
      if (currentAssistantMessageId && !currentAssistantMessageId.innerText.trim()) {
        currentAssistantMessageId.innerHTML = '<em style="opacity:0.7">Stopped.</em>';
      }
      currentAssistantMessageId = null;
      currentThoughtDiv = null;
    } else {
      sendPrompt();
    }
  });

  function sendPrompt() {
    const text = promptInput.value.trim();
    if (!text) {
      return;
    }

    // Queue follow-up while a turn is running (like Copilot / Antigravity)
    if (isWaiting) {
      promptQueue.push({
        text,
        attachments: attachedFiles.slice(),
      });
      promptInput.value = '';
      promptInput.style.height = 'auto';
      syncOverlay();
      attachedFiles = [];
      renderAttachmentChips();
      renderQueueBadge();
      const preview = truncateQueuePreview(text, 80);
      statusText.innerText =
        promptQueue.length === 1
          ? `Queued: “${preview}”`
          : `Queued ${promptQueue.length}: “${truncateQueuePreview(promptQueue[0].text, 60)}” +${promptQueue.length - 1} more`;
      return;
    }

    createMessage('user', text);
    promptInput.value = '';
    promptInput.style.height = 'auto';
    syncOverlay();
    setWaiting(true);

    currentAssistantMessageId = createMessage('assistant');
    currentThoughtDiv = null;
    vscode.postMessage({ type: 'prompt', value: text, attachments: attachedFiles });

    attachedFiles = [];
    renderAttachmentChips();
  }

  // Code Block Processing
  function processCodeBlocks(container, isAssistant = false) {
    container.querySelectorAll('pre:not([data-cp])').forEach(pre => {
      pre.setAttribute('data-cp', '1');
      const code = (pre.querySelector('code') || pre).innerText;
      const lang = [...(pre.querySelector('code')?.classList || [])]
        .find(c => c.startsWith('language-'))?.replace('language-', '') || 'code';

      // Only add actions to assistant messages and for blocks with more than 2 lines
      const lineCount = code.trim().split('\n').length;
      if (!isAssistant || lineCount < 3) {
        return;
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';

      const header = document.createElement('div');
      header.className = 'code-block-header';
      header.innerHTML = `<span class="code-lang">${lang}</span>`;

      const actions = document.createElement('div');
      actions.className = 'code-actions';

      const makeBtn = (icon, label, type, title) => {
        const btn = document.createElement('button');
        btn.className = `code-btn ${type === 'apply' ? 'primary' : ''}`;
        btn.innerHTML = `${ICONS[icon]} <span>${label}</span>`;
        btn.title = title;
        return btn;
      };

      const applyBtn = makeBtn('APPLY', 'Apply', 'apply', 'Apply directly to file');
      applyBtn.onclick = () => {
        vscode.postMessage({ type: 'applyDirect', value: code });
        applyBtn.querySelector('span').innerText = 'Applied!';
        setTimeout(() => {
          applyBtn.querySelector('span').innerText = 'Apply';
        }, 2000);
      };

      const insertBtn = makeBtn('INSERT', 'Insert', 'insert', 'Smart insert at cursor');
      insertBtn.onclick = () => {
        vscode.postMessage({ type: 'insertCode', value: code });
      };

      const copyBtn = makeBtn('COPY', 'Copy', 'copy', 'Copy to clipboard');
      copyBtn.onclick = () => {
        vscode.postMessage({ type: 'copyCode', value: code });
        copyBtn.querySelector('span').innerText = 'Copied!';
        setTimeout(() => {
          copyBtn.querySelector('span').innerText = 'Copy';
        }, 2000);
      };

      const diffBtn = makeBtn('DIFF', 'Diff', 'diff', 'Review changes (Diff)');
      diffBtn.onclick = () => {
        vscode.postMessage({ type: 'applyDiff', value: code });
      };

      actions.append(applyBtn, insertBtn, copyBtn, diffBtn);
      header.appendChild(actions);

      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
    });
  }

  // Main Message Listener
  window.addEventListener('message', ({ data: msg }) => {
    switch (msg.type) {
      case 'status':
        statusText.innerText = msg.value;
        break;

      case 'thought':
        if (currentAssistantMessageId) {
          if (!currentThoughtDiv) {
            currentThoughtDiv = createThoughtBlock(currentAssistantMessageId);
          }
          currentThoughtDiv.innerHTML = msg.value;
          scrollBottom();
        }
        break;

      case 'partial':
        if (currentAssistantMessageId) {
          currentAssistantMessageId.innerHTML = formatMentions(msg.value);
          processCodeBlocks(currentAssistantMessageId, true);
          scrollBottom();
        }
        break;

      case 'suggestContinue':
        if (currentAssistantMessageId) {
          const btn = document.createElement('button');
          btn.className = 'icon-btn continue-btn';
          btn.innerHTML = '🔄 Continue';
          btn.title = 'Continue generating';
          btn.style.marginTop = '10px';
          btn.style.fontSize = '11px';
          btn.onclick = () => {
            btn.remove();
            promptInput.value = 'Continue';
            document.getElementById('send-btn').click();
          };
          currentAssistantMessageId.appendChild(btn);
        }
        break;

      case 'done':
        setWaiting(false);
        if (currentAssistantMessageId) {
          processCodeBlocks(currentAssistantMessageId, true);
          addFeedbackRow(currentAssistantMessageId, currentAssistantMessageId.innerHTML);
          currentAssistantMessageId = null;
          currentThoughtDiv = null;
        }
        break;

      case 'error':
        setWaiting(false);
        const errDiv = currentAssistantMessageId || createMessage('assistant');
        errDiv.innerHTML = `<div style="color: var(--vscode-errorForeground)">${md.render(msg.value)}</div>`;
        currentAssistantMessageId = null;
        currentThoughtDiv = null;
        break;

      case 'modifiedFiles':
        if (currentAssistantMessageId) {
          renderModifiedFiles(msg.value, currentAssistantMessageId);
          scrollBottom();
        }
        break;

      case 'chatHistory':
        renderChatList(msg.value);
        break;

      case 'suggestions':
        showSuggestions(msg.value);
        break;

      case 'models':
        updateModels(msg.value, msg.selected);
        break;

      case 'loadMessages':
        loadMessages(msg.value);
        break;

      case 'fileAttached':
        attachedFiles.push(...msg.value);
        renderAttachmentChips();
        break;

      case 'plan':
        renderPlan(msg.value);
        break;

      case 'artifact':
        renderArtifact(msg.value);
        break;

      case 'artifacts':
        renderArtifacts(msg.value);
        break;

      case 'skills':
        renderSkills(msg.value);
        break;

      case 'completeTask':
        // local UI update only
        const item = document.getElementById(`plan-task-${msg.value}`);
        if (item) {
          const checkbox = item.querySelector('.plan-checkbox');
          checkbox.classList.add('done');
          item.style.opacity = '0.7';
        }
        break;

      case 'timeline':
        allTimelineEvents = msg.value || [];
        renderTimeline(msg.value);
        renderDiagnosticsTab();
        break;

      case 'timelineEvent':
        allTimelineEvents.push(msg.value);
        renderTimelineEvent(msg.value);
        renderDiagnosticsTab();
        break;

      case 'diagnostics':
        systemDiagnostics = msg.value || [];
        renderDiagnosticsTab();
        break;

      case 'agentDebug':
        lastAgentDebug = msg.value || null;
        if (lastAgentDebug && lastAgentDebug.diagnostics) {
          systemDiagnostics = lastAgentDebug.diagnostics;
        }
        renderAgentDebugSession(lastAgentDebug);
        renderDiagnosticsTab();
        break;

      case 'suggestSkill':
        renderSkillSuggestion(msg.value);
        break;

      case 'architectDrafts':
        renderArchitectDrafts(msg.value);
        break;

      case 'terminalOutput':
        appendTerminalLog(msg.value || '', msg.kind || 'out');
        break;
    }
  });

  // ── Sidebar Terminal tab ──
  const terminalLog = document.getElementById('terminal-log');
  const terminalInput = document.getElementById('terminal-input');
  const terminalSendBtn = document.getElementById('terminal-send-btn');
  const termFocusBtn = document.getElementById('term-focus-btn');
  const termClearBtn = document.getElementById('term-clear-btn');

  function appendTerminalLog(text, kind) {
    if (!terminalLog) {
      return;
    }
    const empty = terminalLog.querySelector('.empty-state');
    if (empty) {
      empty.remove();
    }
    const line = document.createElement('div');
    line.className = 'term-line ' + (kind || 'out');
    line.textContent = text;
    terminalLog.appendChild(line);
    terminalLog.scrollTop = terminalLog.scrollHeight;
  }

  function sendTerminalFromSidebar() {
    if (!terminalInput) {
      return;
    }
    const text = terminalInput.value;
    if (!text.trim()) {
      return;
    }
    appendTerminalLog('$ ' + text, 'cmd');
    vscode.postMessage({ type: 'sidebarTerminalRun', value: text });
    terminalInput.value = '';
  }

  if (terminalSendBtn) {
    terminalSendBtn.onclick = sendTerminalFromSidebar;
  }
  if (terminalInput) {
    terminalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendTerminalFromSidebar();
      }
    });
  }
  if (termFocusBtn) {
    termFocusBtn.onclick = () => vscode.postMessage({ type: 'focusTerminal' });
  }
  if (termClearBtn) {
    termClearBtn.onclick = () => {
      if (terminalLog) {
        terminalLog.innerHTML = '<div class="empty-state">Cleared.</div>';
      }
    };
  }

  function renderArchitectDrafts(drafts) {
    if (!drafts || drafts.length === 0 || (Array.isArray(drafts) && drafts.length === 0)) {
      architectDraftsContainer.classList.add('hidden');
      return;
    }
    architectDraftsContainer.classList.remove('hidden');
    draftsList.innerHTML = drafts.map(d => {
      const hunks = d.hunks || [];
      const hunksHtml = hunks.map(h => {
        const linesHtml = h.lines.map(l => {
          const prefix = l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' ';
          const cls = l.type === 'add' ? 'hunk-line-add' : l.type === 'remove' ? 'hunk-line-remove' : 'hunk-line-context';
          return `<div class="${cls}">${prefix} ${escapeHtml(l.value)}</div>`;
        }).join('');
        return `
          <div class="hunk-item" data-hunk-id="${escapeHtml(h.id)}">
            <label class="hunk-toggle">
              <input type="checkbox" class="hunk-accept-checkbox" data-hunk-id="${escapeHtml(h.id)}" checked />
              <span>@@ -${h.oldStart} +${h.newStart} @@</span>
            </label>
            <div class="hunk-lines">${linesHtml}</div>
          </div>
        `;
      }).join('');

      return `
        <div class="draft-item-wrapper" data-draft-path="${escapeHtml(d.path)}">
          <div class="draft-item">
            <span class="draft-path">${escapeHtml(d.path)}</span>
            <span class="draft-lines">${d.lines} lines pending</span>
            ${hunks.length > 0 ? `<button class="draft-review-toggle" type="button">Review ${hunks.length} hunk${hunks.length === 1 ? '' : 's'}</button>` : ''}
          </div>
          <div class="hunks-container hidden">${hunksHtml}</div>
        </div>
      `;
    }).join('');

    // Wire per-file expand/collapse toggles.
    draftsList.querySelectorAll('.draft-review-toggle').forEach(btn => {
      btn.onclick = () => {
        const wrapper = btn.closest('.draft-item-wrapper');
        const hunksContainer = wrapper.querySelector('.hunks-container');
        hunksContainer.classList.toggle('hidden');
      };
    });
  }

  function collectAcceptedHunkSelections() {
    const selections = {};
    draftsList.querySelectorAll('.draft-item-wrapper').forEach(wrapper => {
      const filePath = wrapper.getAttribute('data-draft-path');
      const accepted = Array.from(wrapper.querySelectorAll('.hunk-accept-checkbox:checked')).map(cb => cb.getAttribute('data-hunk-id'));
      selections[filePath] = accepted;
    });
    return selections;
  }



  function renderSkills(skills) {
    if (!skillList) return;

    const headerRow = document.createElement('div');
    headerRow.style.display = 'flex';
    headerRow.style.justifyContent = 'space-between';
    headerRow.style.alignItems = 'center';
    headerRow.style.marginBottom = '10px';

    const title = document.createElement('div');
    title.innerText = 'Your Skills';
    title.style.fontWeight = 'bold';

    const createBtn = document.createElement('button');
    createBtn.className = 'icon-btn';
    createBtn.innerHTML = '+ Create';
    createBtn.style.padding = '2px 8px';
    createBtn.style.fontSize = '11px';
    createBtn.style.background = 'var(--vscode-button-background)';
    createBtn.style.color = 'var(--vscode-button-foreground)';
    createBtn.style.border = 'none';
    createBtn.style.borderRadius = '2px';
    createBtn.onclick = () => showSkillCreationForm();

    headerRow.append(title, createBtn);

    const listContainer = document.createElement('div');

    if (!skills || skills.length === 0) {
      listContainer.innerHTML = '<div class="empty-state">No skills learned yet. Ask the agent to "save a skill" or create one manually.</div>';
    } else {
      skills.forEach(skill => {
        const card = document.createElement('div');
        card.className = 'artifact-card skill-card';
        card.onclick = () => {
          promptInput.value = `Use skill: ${skill.name}`;
          promptInput.focus();
        };

        const type = document.createElement('div');
        type.className = 'artifact-type-badge';
        type.style.background = 'rgba(255, 100, 0, 0.1)';
        type.style.color = '#ff6400';
        type.textContent = 'Skill';

        const cardTitle = document.createElement('div');
        cardTitle.className = 'artifact-card-title';
        cardTitle.textContent = skill.name;

        const detail = document.createElement('div');
        detail.className = 'artifact-card-meta';
        detail.textContent = skill.description;

        card.appendChild(type);
        card.appendChild(cardTitle);
        card.appendChild(detail);
        listContainer.appendChild(card);
      });
    }

    skillList.innerHTML = '';
    skillList.append(headerRow, listContainer);
  }

  function showSkillCreationForm() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal-content';

    modal.innerHTML = `
      <div class="modal-header">
        <div style="background:var(--accent-dim); color:var(--accent); padding:4px; border-radius:6px; display:flex;">${ICONS.SKILL}</div>
        <div class="modal-title">Create New Skill</div>
        <button class="icon-btn modal-close" id="close-modal-btn">${ICONS.CLOSE}</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:12px;">
        <div>
          <label style="display:block; font-size:11px; opacity:0.7; margin-bottom:4px;">Skill Name</label>
          <input type="text" id="new-skill-name" class="skill-form-input" placeholder="e.g. 'Add Error Logging'">
        </div>
        <div>
          <label style="display:block; font-size:11px; opacity:0.7; margin-bottom:4px;">Description</label>
          <input type="text" id="new-skill-desc" class="skill-form-input" placeholder="What does this skill do?">
        </div>
        <div>
          <label style="display:block; font-size:11px; opacity:0.7; margin-bottom:4px;">Instructions</label>
          <textarea id="new-skill-inst" class="skill-form-textarea" placeholder="The specific instructions for the agent..."></textarea>
        </div>
        <div class="modal-footer" style="display:flex; justify-content:flex-end; gap:10px; margin-top:8px;">
          <button id="cancel-skill-btn" class="skill-cancel-btn">Cancel</button>
          <button id="save-skill-btn" class="skill-save-btn">Save Skill</button>
        </div>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const closeModal = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
    modal.querySelector('#close-modal-btn').onclick = closeModal;
    modal.querySelector('#cancel-skill-btn').onclick = closeModal;

    modal.querySelector('#save-skill-btn').onclick = () => {
      const name = modal.querySelector('#new-skill-name').value.trim();
      const desc = modal.querySelector('#new-skill-desc').value.trim();
      const inst = modal.querySelector('#new-skill-inst').value.trim();

      if (name && inst) {
        vscode.postMessage({
          type: 'saveSkillFromSuggestion',
          name: name,
          description: desc || 'Custom skill',
          instructions: inst
        });
        closeModal();
      }
    };
  }

  // Global functions for inline HTML
  window.insertTag = insertTag;

  // ── Timeline Rendering ──
  const TOOL_ICONS = {
    run_command: '⚡', list_dir: '📁', read_file: '📄', edit_file: '✏️',
    create_file: '📝', web_search: '🔍', call_subagent: '🤖', create_artifact: '📦',
    browser_control: '🌐', create_skill: '🧠', use_skill: '🎯', list_skills: '📋',
    grep_search: '🔎', run_tests: '🧪', index_docs: '📖', query_knowledge: '💡'
  };

  function renderTimeline(events) {
    if (!timelineList) return;
    timelineList.innerHTML = '';
    if (!events || events.length === 0) {
      timelineList.innerHTML = '<div class="empty-state">No tool executions yet. The agent\'s actions will appear here.</div>';
      return;
    }
    const counter = document.querySelector('.timeline-count');
    if (counter) counter.textContent = `${events.length} actions`;
    events.forEach((evt, i) => renderTimelineEvent(evt, i));
  }

  function renderTimelineEvent(evt, index) {
    if (!timelineList) return;
    const empty = timelineList.querySelector('.empty-state');
    if (empty) timelineList.innerHTML = '';

    const item = document.createElement('div');
    item.className = `timeline-item ${evt.success ? 'success' : 'error'}`;

    const icon = document.createElement('div');
    icon.className = 'timeline-icon';
    icon.textContent = TOOL_ICONS[evt.tool] || '⚙️';

    const body = document.createElement('div');
    body.className = 'timeline-body';

    const header = document.createElement('div');
    header.className = 'timeline-header';
    header.innerHTML = `<span class="timeline-tool">${evt.tool}</span><span class="timeline-time">${evt.duration}ms</span>`;

    const args = document.createElement('div');
    args.className = 'timeline-args';
    args.textContent = evt.argsSummary;

    const result = document.createElement('div');
    result.className = 'timeline-result';
    result.textContent = evt.resultPreview;

    body.append(header, args, result);
    item.append(icon, body);

    // Undo button
    if (evt.revertContent !== undefined && !evt.reverted) {
      const undoBtn = document.createElement('button');
      undoBtn.className = 'timeline-undo-btn';
      undoBtn.title = 'Undo this action';
      undoBtn.innerHTML = '⏪ Undo';
      undoBtn.onclick = () => {
        vscode.postMessage({ type: 'revertTimelineAction', chatId: evt.chatId, timestamp: evt.timestamp });
      };
      item.appendChild(undoBtn);
    } else if (evt.reverted) {
      const revertedBadge = document.createElement('span');
      revertedBadge.className = 'timeline-reverted-badge';
      revertedBadge.textContent = 'Reverted';
      header.appendChild(revertedBadge);
    }

    timelineList.appendChild(item);

    const counter = document.querySelector('.timeline-count');
    if (counter) counter.textContent = `${timelineList.querySelectorAll('.timeline-item').length} actions`;
  }

  // ── Agent Debug panel: session snapshot + diagnostics + recent tools ──
  function formatDebugTime(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleTimeString();
    } catch {
      return '';
    }
  }

  function renderAgentDebugSession(snap) {
    const el = document.getElementById('agent-debug-session');
    if (!el || !snap) return;
    const total = (snap.tokensIn || 0) + (snap.tokensOut || 0);
    el.innerHTML = `
      <div class="debug-chips">
        <span class="debug-chip"><b>Mode</b> ${escapeHtml(snap.mode || '—')}</span>
        <span class="debug-chip"><b>Provider</b> ${escapeHtml(snap.provider || '—')}</span>
        <span class="debug-chip"><b>Model</b> ${escapeHtml(snap.model || '—')}</span>
        <span class="debug-chip"><b>Tokens</b> in ${Number(snap.tokensIn || 0).toLocaleString()} · out ${Number(snap.tokensOut || 0).toLocaleString()} · Σ ${total.toLocaleString()}</span>
        <span class="debug-chip"><b>Plan</b> ${snap.planDone || 0}/${snap.planTasks || 0}</span>
        <span class="debug-chip mono"><b>Chat</b> ${escapeHtml(String(snap.chatId || '').slice(0, 12) || '—')}</span>
      </div>
    `;
  }

  function renderDiagnosticsTab() {
    const list = document.getElementById('diagnostics-list');
    if (!list) return;

    const snap = lastAgentDebug;
    const diags = (snap && snap.diagnostics) ? snap.diagnostics : systemDiagnostics;
    const tools = (snap && snap.recentTools) ? snap.recentTools : [];
    const failures = allTimelineEvents.filter(e => e.success === false);

    if ((!diags || diags.length === 0) && tools.length === 0 && failures.length === 0) {
      list.innerHTML = '<div class="empty-state">No agent activity yet. Tools, tokens, mode, and warnings will appear here as you work.</div>';
      return;
    }

    let html = '';

    if (tools.length > 0) {
      html += '<div class="diagnostics-section-label">Recent tools (newest first)</div>';
      html += tools.slice(0, 20).map(e => `
        <div class="diagnostic-item ${e.success ? 'info' : 'error'}">
          <div class="diagnostic-header">
            <span class="diagnostic-source">${escapeHtml(e.tool)} ${e.success ? '✓' : '✗'}</span>
            <span class="diagnostic-severity">${e.duration || 0}ms · ${formatDebugTime(e.timestamp)}</span>
          </div>
          <div class="diagnostic-message">${escapeHtml(e.argsSummary || '')}</div>
          <div class="diagnostic-message diagnostic-result">${escapeHtml(e.resultPreview || '')}</div>
        </div>
      `).join('');
    }

    if (diags && diags.length > 0) {
      html += '<div class="diagnostics-section-label">System log</div>';
      html += diags.map(d => `
        <div class="diagnostic-item ${d.severity}">
          <div class="diagnostic-header">
            <span class="diagnostic-source">${escapeHtml(d.source)}</span>
            <span class="diagnostic-severity">${d.severity}${d.timestamp ? ' · ' + formatDebugTime(d.timestamp) : ''}</span>
          </div>
          <div class="diagnostic-message">${escapeHtml(d.message)}</div>
        </div>
      `).join('');
    }

    if (failures.length > 0 && tools.length === 0) {
      html += '<div class="diagnostics-section-label">Failed tool calls</div>';
      html += failures.slice().reverse().slice(0, 15).map(e => `
        <div class="diagnostic-item error">
          <div class="diagnostic-header">
            <span class="diagnostic-source">${escapeHtml(e.tool)}</span>
            <span class="diagnostic-severity">${e.duration}ms</span>
          </div>
          <div class="diagnostic-message">${escapeHtml(e.argsSummary || '')}</div>
          <div class="diagnostic-message diagnostic-result">${escapeHtml(e.resultPreview || '')}</div>
        </div>
      `).join('');
    }

    list.innerHTML = html;
  }

  // ── Proactive Skill Suggestion ──
  function renderSkillSuggestion(data) {
    const existing = document.getElementById('skill-suggestion-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'skill-suggestion-banner';
    banner.className = 'skill-suggestion';
    banner.innerHTML = `
      <div class="skill-suggestion-content">
        <span class="skill-suggestion-icon">🧠</span>
        <div class="skill-suggestion-text">
          <strong>Save as Skill?</strong>
          <span>This task used ${data.toolCount} tools. Save the workflow for reuse.</span>
        </div>
      </div>
      <div class="skill-suggestion-actions">
        <button class="skill-suggestion-btn save">Save Skill</button>
        <button class="skill-suggestion-btn dismiss">Dismiss</button>
      </div>
    `;

    banner.querySelector('.dismiss').onclick = () => banner.remove();
    banner.querySelector('.save').onclick = () => {
      banner.innerHTML = `
        <div class="skill-suggestion-content">
          <input type="text" id="skill-name-input" placeholder="Skill name..." style="background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-focusBorder); padding:4px; border-radius:4px; width:150px;">
        </div>
        <div class="skill-suggestion-actions">
          <button class="skill-suggestion-btn save-confirm">Save</button>
          <button class="skill-suggestion-btn dismiss">Cancel</button>
        </div>
      `;
      const input = banner.querySelector('#skill-name-input');
      input.focus();

      banner.querySelector('.dismiss').onclick = () => banner.remove();
      banner.querySelector('.save-confirm').onclick = () => {
        const name = input.value.trim();
        if (name) {
          vscode.postMessage({
            type: 'saveSkillFromSuggestion',
            name: name,
            description: `Automated workflow with ${data.toolCount} steps: ${data.summary}`,
            instructions: `Repeat this workflow: ${data.summary}`
          });
          banner.remove();
        }
      };
    };

    chatHistory.parentElement.prepend(banner);
    setTimeout(() => { if (banner.parentElement) banner.remove(); }, 30000);
  }

  // Ensure overlay is initialized (fixes text visibility in input)
  setTimeout(() => {
    syncOverlay();
  }, 50);

})();