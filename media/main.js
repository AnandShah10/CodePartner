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
  const suggestionList = document.getElementById('suggestion-list');
  const modelSelector = document.getElementById('model-selector');
  const attachBtn = document.getElementById('attach-btn');
  const attachmentChips = document.getElementById('attachment-chips');

  let currentAssistantMessageId = null;
  let currentThoughtDiv = null;
  let isWaiting = false;
  let attachedFiles = [];

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
    EDIT: '<svg viewBox="0 0 16 16"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25a1.75 1.75 0 0 1 .445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086ZM11.189 6.25l-1.44-1.44L3.083 11.477a.25.25 0 0 0-.064.108l-.446 1.564 1.564-.446a.25.25 0 0 0 .108-.064L11.189 6.25Z"/></svg>'
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
    
    if (Array.isArray(content)) {
      content.forEach(part => {
        if (part.type === 'text') {
          const textSpan = document.createElement('div');
          textSpan.innerHTML = md.render(part.text);
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
    } else {
      contentDiv.innerHTML = content || (role === 'assistant' ? '<div class="spinner"></div>' : '');
    }
    
    messageDiv.appendChild(header);
    messageDiv.appendChild(contentDiv);
    chatHistory.appendChild(messageDiv);
    scrollBottom();
    return contentDiv;
  }

  function createThoughtBlock(container) {
    const thoughtContainer = document.createElement('div');
    thoughtContainer.className = 'thought-container';
    
    const header = document.createElement('div');
    header.className = 'thought-header';
    header.innerHTML = `${ICONS.THOUGHT} <span>Thought</span>`;
    
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
    const lastAt = val.lastIndexOf('@', pos - 1);
    
    if (lastAt !== -1) {
      const before = val.slice(0, lastAt);
      const after = val.slice(pos);
      promptInput.value = before + suggestion.label + (suggestion.type === 'folder' ? '' : ' ') + after;
      promptInput.selectionStart = promptInput.selectionEnd = lastAt + suggestion.label.length + (suggestion.type === 'folder' ? 0 : 1);
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
      opt.innerText = m.name || m.id;
      if (m.id === selected) opt.selected = true;
      modelSelector.appendChild(opt);
    });
  }

  function loadMessages(messages) {
    chatHistory.innerHTML = '';
    messages.forEach(m => {
      if (m.role === 'system') {
        return;
      }
      const content = createMessage(m.role, m.content);
      processCodeBlocks(content, m.role === 'assistant');
    });
    setWaiting(false);
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

  // Handle Input Auto-resize and Suggestions
  promptInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
    
    const pos = promptInput.selectionStart;
    const val = promptInput.value;
    const lastAt = val.lastIndexOf('@', pos - 1);
    
    if (lastAt !== -1 && !val.slice(lastAt, pos).includes(' ')) {
      const query = val.slice(lastAt + 1, pos);
      vscode.postMessage({ type: 'getSuggestions', value: query });
    } else {
      suggestionList.classList.add('hidden');
    }
  });

  // Handle Enter Key and Navigation
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

  modelSelector.onchange = () => {
    vscode.postMessage({ type: 'changeModel', value: modelSelector.value });
  };

  attachBtn.onclick = () => {
    vscode.postMessage({ type: 'attachFiles' });
  };

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
          currentAssistantMessageId.innerHTML = msg.value;
          processCodeBlocks(currentAssistantMessageId, true);
          scrollBottom();
        }
        break;

      case 'done':
        setWaiting(false);
        if (currentAssistantMessageId) {
          processCodeBlocks(currentAssistantMessageId, true);
          currentAssistantMessageId = null;
          currentThoughtDiv = null;
        }
        break;

      case 'error':
        setWaiting(false);
        const errDiv = currentAssistantMessageId || createMessage('assistant');
        errDiv.innerHTML = `<div style="color: var(--vscode-errorForeground)">${msg.value}</div>`;
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
    }
  });

  // Global functions for inline HTML
  window.insertTag = insertTag;

})();
