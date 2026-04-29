(function () {
  const vscode = acquireVsCodeApi();

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
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  const modeBtnFast = document.getElementById('mode-fast');
  const modeBtnPlan = document.getElementById('mode-plan');

  let currentAssistantMessageId = null;
  let currentThoughtDiv = null;
  let isWaiting = false;
  let attachedFiles = [];
  let currentMode = 'fast';

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

  function setWaiting(waiting) {
    isWaiting = waiting;
    sendBtn.innerHTML = waiting ? ICONS.STOP : ICONS.SEND;
    sendBtn.classList.toggle('stop', waiting);
    if (!waiting) {
      statusText.innerText = '';
    }
  }

  function formatMentions(html) {
    if (!html) return html;
    
    let formatted = html.replace(/(^|\s|>|&nbsp;)@([a-zA-Z0-9_\-\.\/]+)/g, (match, prefix, path) => {
      const parts = path.split('/');
      let displayHtml = '';
      
      if (parts.length === 1) {
        displayHtml = `@<b>${path}</b>`;
      } else {
        const basename = parts.pop();
        if (basename === '') {
          const lastDir = parts.pop();
          const preDir = parts.length > 0 ? parts.join('/') + '/' : '';
          displayHtml = `@${preDir}<b>${lastDir}/</b>`;
        } else {
          const dir = parts.length > 0 ? parts.join('/') + '/' : '';
          displayHtml = `@${dir}<b>${basename}</b>`;
        }
      }
      
      return `${prefix}<span class="mention" style="color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-size: 0.9em;">${displayHtml}</span>`;
    });

    formatted = formatted.replace(/(^|\s|>|&nbsp;)\/([a-zA-Z0-9_\-\.]+)/g, (match, prefix, skillName) => {
      return `${prefix}<span class="mention" style="color: var(--vscode-charts-purple); font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-size: 0.9em;">/<b>${skillName}</b></span>`;
    });

    return formatted;
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
    feedbackRow.style.display = 'flex';
    feedbackRow.style.flexDirection = 'column';
    feedbackRow.style.gap = '4px';
    feedbackRow.style.marginTop = '8px';

    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.gap = '8px';
    buttons.style.opacity = '0.6';

    const feedbackInputContainer = document.createElement('div');
    feedbackInputContainer.className = 'hidden';
    feedbackInputContainer.style.marginTop = '4px';

    const likeBtn = document.createElement('button');
    likeBtn.className = 'icon-btn';
    likeBtn.title = 'Helpful';
    likeBtn.innerHTML = ICONS.LIKE;
    likeBtn.onclick = () => {
      vscode.postMessage({ type: 'feedback', value: 'positive', content: content });
      feedbackRow.remove();
    };

    const dislikeBtn = document.createElement('button');
    dislikeBtn.className = 'icon-btn';
    dislikeBtn.title = 'Not helpful';
    dislikeBtn.innerHTML = ICONS.DISLIKE;
    dislikeBtn.onclick = () => {
      dislikeBtn.style.color = 'var(--vscode-charts-red)';
      dislikeBtn.style.opacity = '1';
      likeBtn.style.color = 'inherit';
      likeBtn.style.opacity = '0.6';
      feedbackInputContainer.classList.remove('hidden');
      feedbackInput.focus();
    };

    const feedbackInput = document.createElement('input');
    feedbackInput.placeholder = 'What was wrong? (optional)';
    feedbackInput.className = 'skill-form-input';
    feedbackInput.style.height = '24px';
    feedbackInput.style.fontSize = '10px';
    feedbackInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        vscode.postMessage({ type: 'feedback', value: 'negative', detail: feedbackInput.value, content: content });
        feedbackInputContainer.innerHTML = '<span style="font-size:10px; opacity:0.6;">Thanks for the feedback!</span>';
        setTimeout(() => feedbackRow.remove(), 2000);
      }
    };

    feedbackInputContainer.appendChild(feedbackInput);
    buttons.append(likeBtn, dislikeBtn);
    feedbackRow.append(buttons, feedbackInputContainer);
    container.parentElement.appendChild(feedbackRow);
    scrollBottom();
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
      opt.innerText = m.name || m.id;
      if (m.id === selected) {
        opt.selected = true;
      }
      modelSelector.appendChild(opt);
    });
  }

  function loadMessages(messages) {
    chatHistory.innerHTML = '';
    messages.forEach(m => {
      if (m.role === 'system' || m.hiddenFromUI) {
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
  };

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
    planList.innerHTML = '';
    if (!tasks || tasks.length === 0) {
      planList.innerHTML = '<div class="empty-state">No active plan. Use Planning mode for complex tasks.</div>';
      return;
    }
    // Progress counter
    const doneCount = tasks.filter(t => t.done).length;
    const progressEl = document.querySelector('.plan-progress');
    if (progressEl) progressEl.textContent = `${doneCount}/${tasks.length} done`;

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
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let formatted = escaped.replace(/(^|\s)@([a-zA-Z0-9_\-\.\/]+)/g, (match, prefix, path) => {
      const parts = path.split('/');
      let displayHtml = '';
      if (parts.length === 1) {
        displayHtml = `@<b>${path}</b>`;
      } else {
        const basename = parts.pop();
        if (basename === '') {
          const lastDir = parts.pop();
          const preDir = parts.length > 0 ? parts.join('/') + '/' : '';
          displayHtml = `@${preDir}<b>${lastDir}/</b>`;
        } else {
          const dir = parts.length > 0 ? parts.join('/') + '/' : '';
          displayHtml = `@${dir}<b>${basename}</b>`;
        }
      }
      return `${prefix}<span style="color: var(--vscode-textLink-foreground); font-weight: 600; background: rgba(var(--vscode-textLink-foreground-rgb, 0,120,212), 0.15); padding: 0 4px; border-radius: 3px;">${displayHtml}</span>`;
    });

    formatted = formatted.replace(/(^|\s)\/([a-zA-Z0-9_\-\.]+)/g, (match, prefix, skillName) => {
      return `${prefix}<span style="color: var(--vscode-charts-purple); font-weight: 600; background: rgba(var(--vscode-charts-purple-rgb, 128,0,128), 0.15); padding: 0 4px; border-radius: 3px;">/<b>${skillName}</b></span>`;
    });
    
    if (formatted.endsWith('\n')) formatted += '<br>';
    return formatted;
  }

  function syncOverlay() {
    promptOverlay.innerHTML = formatMentionsForOverlay(promptInput.value);
    promptOverlay.style.height = promptInput.style.height;
    promptOverlay.scrollTop = promptInput.scrollTop;
  }

  // Handle Input Auto-resize and Suggestions
  promptInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
    syncOverlay();

    const pos = promptInput.selectionStart;
    const val = promptInput.value;
    const lastAt = val.lastIndexOf('@', pos - 1);
    const lastSlash = val.lastIndexOf('/', pos - 1);

    if (lastAt !== -1 && !val.slice(lastAt, pos).includes(' ') && lastAt >= lastSlash) {
      const query = val.slice(lastAt + 1, pos);
      vscode.postMessage({ type: 'getSuggestions', value: { type: '@', query } });
    } else if (lastSlash !== -1 && !val.slice(lastSlash, pos).includes(' ') && lastSlash > lastAt) {
      const query = val.slice(lastSlash + 1, pos);
      vscode.postMessage({ type: 'getSuggestions', value: { type: '/', query } });
    } else {
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

  modelSelector.onchange = () => {
    vscode.postMessage({ type: 'changeModel', value: modelSelector.value });
  };

  attachBtn.onclick = () => {
    vscode.postMessage({ type: 'attachFiles' });
  };

  const applyDraftsBtn = document.getElementById('apply-drafts-btn');
  if (applyDraftsBtn) {
    applyDraftsBtn.onclick = () => {
      vscode.postMessage({ type: 'applyDrafts' });
    };
  }

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
        const planTabBtn = document.querySelector('[data-tab="plan"]');
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
        renderTimeline(msg.value);
        break;

      case 'timelineEvent':
        renderTimelineEvent(msg.value);
        break;

      case 'suggestSkill':
        renderSkillSuggestion(msg.value);
        break;

      case 'architectDrafts':
        renderArchitectDrafts(msg.value);
        break;
    }
  });

  function renderArchitectDrafts(drafts) {
    if (!drafts || drafts.length === 0 || (Array.isArray(drafts) && drafts.length === 0)) {
      architectDraftsContainer.classList.add('hidden');
      return;
    }
    architectDraftsContainer.classList.remove('hidden');
    draftsList.innerHTML = drafts.map(d => `
      <div class="draft-item">
        <span class="draft-path">${d.path}</span>
        <span class="draft-lines">${d.lines} lines pending</span>
      </div>
    `).join('');
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

})();
