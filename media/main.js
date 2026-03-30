(function () {
  const vscode = acquireVsCodeApi();
  const chatHistory = document.getElementById('chat-history');
  const promptInput = document.getElementById('prompt-input');
  const sendBtn = document.getElementById('send-btn');
  const statusText = document.getElementById('status-text');
  const historyBtn = document.getElementById('history-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const closeHistoryBtn = document.getElementById('close-history');
  const historyPanel = document.getElementById('history-panel');
  const chatList = document.getElementById('chat-list');

  let currentAssistantMessageId = null;
  let isWaiting = false;

  const ICONS = {
    SEND: '<svg viewBox="0 0 16 16"><path d="M1.724 1.053a.5.5 0 0 0-.714.545l1.403 4.85a.5.5 0 0 0 .397.354l5.69.953c.268.053.268.437 0 .49l-5.69.953a.5.5 0 0 0-.397.354l-1.403 4.85a.5.5 0 0 0 .714.545l13-6.5a.5.5 0 0 0 0-.894l-13-6.5Z"/></svg>',
    STOP: '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
    APPLY: '<svg viewBox="0 0 16 16"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>',
    INSERT: '<svg viewBox="0 0 16 16"><path d="M1 2h2v2H1V2zm0 4h2v2H1V6zm0 4h2v2H1v-2zm4-8h10v2H5V2zm0 4h10v2H5V6zm0 4h6v2H5v-2z"/></svg>',
    COPY: '<svg viewBox="0 0 16 16"><path d="M4 4h8v1H4V4zm0 2h8v1H4V6zm0 2h5v1H4V8zm8-7H3L2 2v11l1 1h4v-1H3V2h8v1h1V2l-1-1zm2 4h-7l-1 1v8l1 1h7l1-1V6l-1-1zm0 9H6V6h7v9z"/></svg>',
    DIFF: '<svg viewBox="0 0 16 16"><path d="M6 3h4v2H6V3zm0 4h4v2H6V7zm0 4h4v2H6v-2zM2 3h3v2H2V3zm0 4h3v2H2V7zm0 4h3v2H2v-2zm9 0h3v2h-3v-2zm0-4h3v2h-3V7zm0-4h3v2h-3V3z"/></svg>',
    TRASH: '<svg viewBox="0 0 16 16"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 1 0-1.492.15l.66 6.623C3.844 14.555 4.805 16 6.002 16h3.996c1.197 0 2.158-1.445 2.338-2.552l.66-6.623a.75.75 0 0 0-1.492-.15l-.66 6.623a.853.853 0 0 1-.845.727H6.002a.853.853 0 0 1-.845-.727l-.66-6.623zM6.75 1.5h2.5v1.5h-2.5V1.5z"/></svg>'
  };

  function scrollBottom() {
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }

  function setWaiting(waiting) {
    isWaiting = waiting;
    sendBtn.innerHTML = waiting ? ICONS.STOP : ICONS.SEND;
    sendBtn.classList.toggle('stop', waiting);
    if (!waiting) {
      statusText.innerText = '';
    }
  }

  function createMessage(role, content = '') {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;
    
    const header = document.createElement('div');
    header.className = 'message-header';
    header.innerText = role === 'user' ? 'You' : 'CodePartner';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.innerHTML = content || (role === 'assistant' ? '<div class="spinner"></div>' : '');
    
    messageDiv.appendChild(header);
    messageDiv.appendChild(contentDiv);
    chatHistory.appendChild(messageDiv);
    scrollBottom();
    return contentDiv;
  }

  function renderChatList(chats) {
    chatList.innerHTML = '';
    chats.forEach(chat => {
      const item = document.createElement('div');
      item.className = 'chat-item';
      
      const title = document.createElement('div');
      title.className = 'chat-item-title';
      title.innerText = chat.title || 'Untitled Chat';
      
      const meta = document.createElement('div');
      meta.className = 'chat-item-meta';
      meta.innerText = new Date(chat.timestamp).toLocaleString();

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.justifyContent = 'space-between';
      actions.style.alignItems = 'center';

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

      actions.append(title, deleteBtn);
      item.append(actions, meta);
      chatList.appendChild(item);
    });
  }

  function loadMessages(messages) {
    chatHistory.innerHTML = '';
    messages.forEach(m => {
      if (m.role === 'system') {
        return;
      }
      const content = createMessage(m.role, m.content);
      processCodeBlocks(content);
    });
    scrollBottom();
  }

  // UI Event Listeners
  historyBtn.onclick = () => {
    vscode.postMessage({ type: 'listChats' });
    historyPanel.classList.remove('hidden');
  };

  closeHistoryBtn.onclick = () => {
    historyPanel.classList.add('hidden');
  };

  newChatBtn.onclick = () => {
    vscode.postMessage({ type: 'clearChat' });
    historyPanel.classList.add('hidden');
  };

  function insertTag(tag) {
    const pos = promptInput.selectionStart;
    const val = promptInput.value;
    promptInput.value = val.slice(0, pos) + tag + val.slice(pos);
    promptInput.focus();
    promptInput.selectionStart = promptInput.selectionEnd = pos + tag.length;
  }

  // Handle Input Auto-resize
  promptInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
  });

  // Handle Enter Key
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  // Handle Send/Stop click
  sendBtn.addEventListener('click', () => {
    if (isWaiting) {
      vscode.postMessage({ type: 'cancel' });
      setWaiting(false);
    } else {
      sendPrompt();
    }
  });

  function sendPrompt() {
    const text = promptInput.value.trim();
    if (!text || isWaiting) {
      return;
    }

    createMessage('user', text);
    promptInput.value = '';
    promptInput.style.height = 'auto';
    setWaiting(true);

    currentAssistantMessageId = createMessage('assistant');
    vscode.postMessage({ type: 'prompt', value: text });
  }

  // Code Block Processing
  function processCodeBlocks(container) {
    container.querySelectorAll('pre:not([data-cp])').forEach(pre => {
      pre.setAttribute('data-cp', '1');
      const code = (pre.querySelector('code') || pre).innerText;
      const lang = [...(pre.querySelector('code')?.classList || [])]
        .find(c => c.startsWith('language-'))?.replace('language-', '') || 'code';

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
        setTimeout(() => applyBtn.querySelector('span').innerText = 'Apply', 2000);
      };

      const insertBtn = makeBtn('INSERT', 'Insert', 'insert', 'Smart insert at cursor');
      insertBtn.onclick = () => vscode.postMessage({ type: 'insertCode', value: code });

      const copyBtn = makeBtn('COPY', 'Copy', 'copy', 'Copy to clipboard');
      copyBtn.onclick = () => {
        vscode.postMessage({ type: 'copyCode', value: code });
        copyBtn.querySelector('span').innerText = 'Copied!';
        setTimeout(() => copyBtn.querySelector('span').innerText = 'Copy', 2000);
      };

      const diffBtn = makeBtn('DIFF', 'Diff', 'diff', 'Review changes (Diff)');
      diffBtn.onclick = () => vscode.postMessage({ type: 'applyDiff', value: code });

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

      case 'partial':
        if (currentAssistantMessageId) {
          currentAssistantMessageId.innerHTML = msg.value;
          processCodeBlocks(currentAssistantMessageId);
          scrollBottom();
        }
        break;

      case 'done':
        setWaiting(false);
        if (currentAssistantMessageId) {
          processCodeBlocks(currentAssistantMessageId);
          currentAssistantMessageId = null;
        }
        break;

      case 'error':
        setWaiting(false);
        const errDiv = currentAssistantMessageId || createMessage('assistant');
        errDiv.innerHTML = `<div style="color: var(--vscode-errorForeground)">${msg.value}</div>`;
        currentAssistantMessageId = null;
        break;

      case 'chatHistory':
        renderChatList(msg.value);
        break;

      case 'loadMessages':
        loadMessages(msg.value);
        break;
    }
  });

  // Global functions for inline HTML
  window.insertTag = insertTag;

})();
