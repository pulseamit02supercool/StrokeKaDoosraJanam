/* ──────────────────────────────────────
   Stroke — Multi-User Gmail Frontend
   Uses Google OAuth2 + Gmail API directly.
   No backend server needed.
   ────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {

  /* ── Element refs ── */
  
  /* ── Cross-Origin Token Handler ── */
  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');
  if (tokenFromUrl) {
    document.cookie = 'stroke_token=' + tokenFromUrl + '; path=/; max-age=' + (60 * 60 * 24 * 7);
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const STROKE_API_BASE = (typeof STROKE_CONFIG !== 'undefined' && STROKE_CONFIG.API_BASE) ? STROKE_CONFIG.API_BASE : '';
  
  // Custom fetch wrapper to handle Base URL and Authorization Header
  function apiFetch(endpoint, options = {}) {
    const url = STROKE_API_BASE + endpoint;
    const opts = { ...options };
    
    opts.headers = opts.headers || {};
    
    // Always include credentials for SameSite cookie support where applicable
    opts.credentials = 'include';
    
    // Extract token from document.cookie
    const match = document.cookie.match(new RegExp('(^| )stroke_token=([^;]+)'));
    if (match) {
        opts.headers['Authorization'] = 'Bearer ' + match[2];
    }
    
    return fetch(url, opts);
  }

  const $ = id => document.getElementById(id);
  const btnSignIn     = $('btn-signin');
  const btnSignOut    = $('btn-signout');
  const btnEditName   = $('btn-edit-name');
  const signedOutView = $('signed-out-view');
  const signedInView  = $('signed-in-view');
  const userAvatar    = $('user-avatar');
  const userName      = $('user-name');
  const userEmailEl   = $('user-email');
  const actionSel     = $('action-select');
  const followupConfig = $('followup-config');
  const followupCount = $('followup-count');
  const followupList = $('followup-list');
  const csvInput      = $('csv-file');
  const dropZone      = $('file-drop-zone');
  const dropText      = $('file-drop-text');
  const detectedVars  = $('detected-vars');
  const varChips      = $('var-chips');
  const subjectGroup  = $('subject-group');
  const bodyGroup     = $('body-group');
  const subjectTpl    = $('subject-tpl');
  const bodyEditor    = $('body-editor');
  const bodyToolbar   = $('body-toolbar');
  const sigSelect     = $('signature-select');
  const btnManageSig  = $('btn-manage-sig');
  const previewPane   = $('preview-pane');
  const previewCount  = $('preview-counter');
  const btnPrev       = $('prev-row');
  const btnNext       = $('next-row');
  const btnSend       = $('btn-send');
  const progressArea  = $('progress-area');
  const progressFill  = $('progress-fill');
  const progressText  = $('progress-text');
  const resultsArea   = $('results-area');
  const resultsThead  = $('results-thead');
  const resultsTbody  = $('results-tbody');
  
  // Timezone Elements
  const enableLocalTz       = $('enable-local-tz');
  const tzColumnSelect      = $('tz-column-select');
  const tzSettingsGroup     = $('tz-settings-group');
  const tzLocalOptions      = $('tz-local-options');
  const verifyTimezones     = $('verify-timezones');
  const tzVerificationModal = $('tz-verification-modal');
  const btnCloseTzModal     = $('btn-close-tz-modal');
  const btnCancelTzVerification = $('btn-cancel-tz-verification');
  const btnConfirmTzLaunch  = $('btn-confirm-tz-launch');
  const tzVerificationTbody = $('tz-verification-tbody');
  
  // Modal Elements
  const sigModal      = $('sig-modal');
  const sigList       = $('sig-list');
  const sigName       = $('sig-name');
  const sigContent    = $('sig-content');
  const sigToolbar    = $('sig-toolbar');
  const sigEditId     = $('sig-edit-id');
  const btnSaveSig    = $('btn-save-sig');
  const btnCancelEditSig = $('btn-cancel-edit-sig');
  const btnCloseSigModal = $('btn-close-sig-modal');
  const sigEditorTitle= $('sig-editor-title');

  // Template Elements
  const templateSelect = $('template-select');
  const btnManageTemplates = $('btn-manage-templates');
  const templateModal = $('template-modal');
  const templateList = $('template-list');
  const templateName = $('template-name');
  const btnSaveTemplate = $('btn-save-template');
  const btnCloseTemplateModal = $('btn-close-template-modal');
  const templateSaveStatus = $('template-save-status');

  const manageSection = $('manage-section');
  const campaignsTbody = $('campaigns-tbody');
  const editCampModal = $('edit-campaign-modal');
  const btnCloseEditModal = $('btn-close-edit-modal');
  const editCampId = $('edit-camp-id');
  const editCampSubject = $('edit-camp-subject');
  const editCampBody = $('edit-camp-body');
  const editCampToolbar = $('edit-camp-toolbar');
  const btnSaveCampaign = $('btn-save-campaign');
  const btnCancelCampaign = $('btn-cancel-campaign');
  const editCampStatus = $('edit-camp-status');
  
  const editCampFollowupsContainer = $('edit-camp-followups-container');
  const editCampFollowupsList = $('edit-camp-followups-list');
  let currentEditFollowups = [];

  const editCampRecipientsContainer = $('edit-camp-recipients-container');
  const editCampRecipientsSearch = $('edit-camp-recipients-search');
  const editCampRecipientsList = $('edit-camp-recipients-list');
  let currentEditEmails = [];

  /* ── Auth State & Cookie Parsing ── */
  let userSignatures = [];
  let csvRaw = null;
  let headers = [];
  let rows = [];
  let previewIdx = 0;
  let logs = [];
  let followupDrafts = [];
  let lastFocusedInput = null;

  document.addEventListener('focusin', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      lastFocusedInput = e.target;
    }
  });

  function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
  }

  function parseJwt(token) {
    try {
      return JSON.parse(atob(token.split('.')[1]));
    } catch (e) { return null; }
  }

  const strokeToken = getCookie('stroke_token');
  const user = strokeToken ? parseJwt(strokeToken) : null;

  let bgWorkerInterval = null;

  if (user) {
    userName.textContent = user.name || 'User';
    userEmailEl.textContent = user.email || '';
    userAvatar.src = user.avatar || '';

    signedOutView.style.display = 'none';
    signedInView.style.display = 'flex';
    btnSend.disabled = false;

    // Load saved signatures and templates
    fetchSignatures();
    fetchTemplates();
    fetchCampaigns();
    startBackgroundWorker();
    
    document.getElementById('bg-worker-status').style.display = 'inline-flex';
    manageSection.style.display = 'block';

  } else {
    signedOutView.style.display = 'block';
    signedInView.style.display = 'none';
    btnSend.disabled = true;
    document.getElementById('bg-worker-status').style.display = 'none';
  }

  function startBackgroundWorker() {
    if (bgWorkerInterval) return;
    apiFetch('/api/cron/process').catch(() => {}); // trigger once immediately on load
    bgWorkerInterval = setInterval(() => {
      apiFetch('/api/cron/process').catch(e => console.error('Auto CRON error:', e));
    }, 60000); // exactly every 60 seconds
  }

  btnSignOut.addEventListener('click', () => {
    document.cookie = 'stroke_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
    window.location.href = '/'; // Reload
  });

  if (btnEditName) {
    btnEditName.addEventListener('click', async () => {
      const currentName = userName.textContent;
      const newName = prompt('Enter your new sender name:', currentName);
      if (newName !== null && newName.trim() !== '' && newName.trim() !== currentName) {
        try {
          btnEditName.disabled = true;
          const res = await apiFetch('/api/users/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
          });
          if (!res.ok) throw new Error('Failed to update name');
          const data = await res.json();
          userName.textContent = data.name;
        } catch (err) {
          alert('Error updating name: ' + err.message);
        } finally {
          btnEditName.disabled = false;
        }
      }
    });
  }

  // Sign in via backend OAuth route. If backend is not running, show a clear error.
  btnSignIn?.addEventListener('click', async () => {
    btnSignIn.disabled = true;
    try {
      const res = await apiFetch('/api/auth/login', { method: 'GET', redirect: 'manual' });
      if (res.status === 404 || res.status === 500) {
        throw new Error('Auth API is not available on this host');
      }
      window.location.href = STROKE_API_BASE + '/api/auth/login';
    } catch (err) {
      alert(
        'Google Sign-In backend is not reachable.\n\n' +
        'You are likely running only static files (python server).\n' +
        'Run this app with its API routes (Vercel/Node) and set OAuth env vars:\n' +
        'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SUPABASE_URL, SUPABASE_KEY, JWT_SECRET.'
      );
    } finally {
      btnSignIn.disabled = false;
    }
  });

  /* ──────────────────────────────────
     CSV Parsing (handles quoted fields)
     ────────────────────────────────── */

  function parseCSV(text) {
    const result = [];
    let row = [];
    let inQuote = false;
    let field = '';

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuote) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') { inQuote = false; }
        else { field += c; }
      } else {
        if (c === '"') { inQuote = true; }
        else if (c === ',') { row.push(field.trim()); field = ''; }
        else if (c === '\n' || c === '\r') {
          row.push(field.trim());
          if (row.some(f => f !== '')) result.push(row);
          row = []; field = '';
          if (c === '\r' && text[i + 1] === '\n') i++;
        } else { field += c; }
      }
    }
    row.push(field.trim());
    if (row.some(f => f !== '')) result.push(row);
    return result;
  }

  function loadCSV(text) {
    csvRaw = text;
    const parsed = parseCSV(text);
    if (parsed.length < 2) { alert('CSV must have a header + at least one data row.'); return; }
    headers = parsed[0];
    rows = parsed.slice(1);
    previewIdx = 0;

    varChips.innerHTML = '';
    headers.forEach(h => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `{{${h}}}`;
      chip.title = 'Click to insert into the email body';
      chip.addEventListener('click', () => insertVariableToken(`{{${h}}}`));
      varChips.appendChild(chip);
    });
    detectedVars.style.display = 'flex';
    dropText.innerHTML = `<strong>${headers.length}</strong> columns · <strong>${rows.length}</strong> rows loaded`;
    
    // Populate location/timezone column dropdown
    if (tzColumnSelect) {
      tzColumnSelect.innerHTML = '<option value="">-- Select Location Column --</option>' +
        headers.map(h => `<option value="${h}">${escapeHtml(h)}</option>`).join('');
      // Auto-detect location/timezone columns prioritizing explicit timezone columns
      const autoCol = headers.find(h => {
        const clean = h.trim().toLowerCase();
        return clean === 'timezone' || clean === 'tz' || clean === 'time zone' || clean === 'time_zone';
      }) || headers.find(h => {
        const clean = h.trim().toLowerCase();
        return clean.includes('timezone') || clean.includes('tz') || clean.includes('zone');
      }) || headers.find(h => {
        const clean = h.trim().toLowerCase();
        return clean.includes('location') || clean.includes('country') || clean.includes('city');
      });
      if (autoCol) {
        tzColumnSelect.value = autoCol;
      }
    }
    
    renderPreview();
  }

  /* ──────────────────────────────────
     Drag & Drop
     ────────────────────────────────── */
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('dragover'); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
  csvInput.addEventListener('change', e => { 
    if (e.target.files[0]) {
      readFile(e.target.files[0]); 
      e.target.value = ''; 
    }
  });
  function readFile(file) { const r = new FileReader(); r.onload = ev => loadCSV(ev.target.result); r.readAsText(file); }

  /* ──────────────────────────────────
     Variable Engine (case-insensitive)
     ────────────────────────────────── */
  function replaceVars(template, row) {
    let out = template || '';
    out = out.replace(/<span[^>]*class="email-var"[^>]*>(.*?)<\/span>/gi, '$1');
    headers.forEach((h, i) => {
      const rx = new RegExp('\\{\\{\\s*' + escapeRegex(h) + '\\s*\\}\\}', 'gi');
      out = out.replace(rx, row[i] || '');
    });
    return out;
  }
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function cleanPasteHtml(html, text) {
    if (!html) return escapeHtml(text).replace(/\n/g, '<br/>');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const allowed = ['A', 'B', 'STRONG', 'I', 'EM', 'U', 'BR', 'P', 'UL', 'OL', 'LI', 'DIV', 'SPAN', 'IMG', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH', 'CODE', 'PRE', 'BLOCKQUOTE'];
    const nodes = Array.from(doc.body.getElementsByTagName('*')).reverse();
    
    for (const node of nodes) {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') {
        node.parentNode.removeChild(node);
      } else if (!allowed.includes(node.tagName)) {
        while (node.firstChild) node.parentNode.insertBefore(node.firstChild, node);
        node.parentNode.removeChild(node);
      } else {
        const allowedAttrs = ['style', 'href', 'src', 'alt', 'width', 'height', 'cellpadding', 'cellspacing', 'border', 'valign', 'align'];
        for (const attr of Array.from(node.attributes)) {
          if (!allowedAttrs.includes(attr.name.toLowerCase())) {
            node.removeAttribute(attr.name);
          }
        }
      }
    }
    return doc.body.innerHTML || escapeHtml(text).replace(/\n/g, '<br/>');
  }

  function markdownToHtml(text) {
    if (!text) return '';
    let html = escapeHtml(String(text).replace(/\r\n/g, '\n'));
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;" />');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return html.replace(/\n/g, '<br/>');
  }

  function isEmptyRichHtml(html) {
    const normalized = (html || '')
      .replace(/<br\s*\/?>/gi, '')
      .replace(/&nbsp;/gi, '')
      .replace(/<p>\s*<\/p>/gi, '')
      .trim();
    return !normalized;
  }

  function getBodyTemplateHtml() {
    const raw = bodyEditor?.innerHTML || '';
    return isEmptyRichHtml(raw) ? '' : raw;
  }

  function getEditorHtml(editor) {
    if (!editor) return '';
    const raw = editor.innerHTML || '';
    return isEmptyRichHtml(raw) ? '' : raw;
  }

  function getSelectedSignatureContent() {
    const selectedSigId = sigSelect.value;
    if (!selectedSigId) return '';
    const sigObj = userSignatures.find(s => s.id === selectedSigId);
    return sigObj?.content || '';
  }

  function joinEmailSections(sections) {
    return sections.filter(Boolean).join('<div style="height:16px; line-height:16px;">&nbsp;</div>');
  }

  function buildEmailTemplateHtml() {
    const rawSig = getSelectedSignatureContent();
    const sigHtml = /<\/?[a-z][\s\S]*>/i.test(rawSig) ? rawSig : markdownToHtml(rawSig);
    return joinEmailSections([
      getBodyTemplateHtml() ? `<div>${getBodyTemplateHtml()}</div>` : '',
      rawSig ? `<div>${sigHtml}</div>` : ''
    ]);
  }

  function buildFollowupTemplateHtml(bodyText) {
    const rawSig = getSelectedSignatureContent();
    const sigHtml = /<\/?[a-z][\s\S]*>/i.test(rawSig) ? rawSig : markdownToHtml(rawSig);
    return joinEmailSections([
      bodyText ? `<div>${bodyText}</div>` : '',
      rawSig ? `<div>${sigHtml}</div>` : ''
    ]);
  }

  function insertVariableToken(token) {
    const target = lastFocusedInput || bodyEditor;
    
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      const start = target.selectionStart || 0;
      const end = target.selectionEnd || 0;
      const val = target.value;
      target.value = val.slice(0, start) + token + val.slice(end);
      target.selectionStart = target.selectionEnd = start + token.length;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      target.focus();
      const selection = window.getSelection();
      
      const span = document.createElement('span');
      span.className = 'email-var';
      span.contentEditable = 'false';
      span.textContent = token;

      if (!selection || !selection.rangeCount || !target.contains(selection.anchorNode)) {
        target.append(span);
        target.append(document.createTextNode('\u00A0'));
      } else {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        
        const spaceNode = document.createTextNode('\u00A0');
        range.insertNode(spaceNode);
        range.insertNode(span);
        
        range.setStartAfter(spaceNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    renderPreview();
  }

  function runRichCommand(editor, command) {
    if (!editor) return;
    editor.focus();
    if (command === 'createLink') {
      const url = window.prompt('Enter the full URL for this link:', 'https://');
      if (!url) return;
      document.execCommand('createLink', false, url);
      return;
    }
    document.execCommand(command, false, null);
  }

  function resolveTimezoneName(locationOrTz) {
    if (!locationOrTz) return 'Asia/Kolkata';
    const clean = String(locationOrTz).trim();
    if (!clean) return 'Asia/Kolkata';

    // Try to match standard IANA names by checking if standard formatting passes
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: clean });
      return clean;
    } catch(e) {}

    // Check for standard offsets like +05:30, -0400, etc.
    const offsetMatch = clean.match(/^([+-])(\d{1,2}):?(\d{2})?$/);
    if (offsetMatch) {
      const sign = offsetMatch[1];
      const hh = String(offsetMatch[2]).padStart(2, '0');
      const mm = String(offsetMatch[3] || '00').padStart(2, '0');
      return `UTC${sign}${hh}:${mm}`;
    }

    // Try decimal offset
    const num = Number(clean);
    if (!isNaN(num)) {
      const sign = num >= 0 ? '+' : '-';
      const absNum = Math.abs(num);
      const hh = String(Math.floor(absNum)).padStart(2, '0');
      const mm = String(Math.round((absNum % 1) * 60)).padStart(2, '0');
      return `UTC${sign}${hh}:${mm}`;
    }

    return 'Google Maps API Resolution';
  }

  /* ──────────────────────────────────
     Preview
     ────────────────────────────────── */
  function renderPreview() {
    if (!rows.length) return;
    const row = rows[previewIdx];
    const subj = replaceVars(subjectTpl.value || '(no subject)', row);
    const ccVal = replaceVars($('cc-emails')?.value || '', row);
    const body = replaceVars(buildEmailTemplateHtml(), row);
    
    let tzHeader = '';
    const isSchedule = document.querySelector('input[name="sendTiming"]:checked')?.value === 'schedule';
    if (isSchedule && enableLocalTz && enableLocalTz.checked) {
      const colName = tzColumnSelect.value;
      if (colName) {
        const colIdx = headers.indexOf(colName);
        if (colIdx !== -1) {
          const rawLoc = row[colIdx] || '';
          const resolvedTz = resolveTimezoneName(rawLoc);
          const scheduleInput = scheduleTimeInput.value;
          
          let dateText = 'N/A';
          if (scheduleInput) {
            try {
              // Get the target wall-clock time
              const localDate = new Date(scheduleInput); // wall clock
              dateText = localDate.toLocaleString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
                hour: 'numeric', minute: 'numeric', hour12: true
              }) + ` (in recipient timezone: ${resolvedTz})`;
            } catch (err) {
              dateText = 'Invalid Date';
            }
          }
          
          tzHeader = `
            <div style="background:rgba(99, 102, 241, 0.1); border:1px solid rgba(99, 102, 241, 0.2); padding:10px 14px; border-radius:var(--radius-sm); margin-bottom:15px; font-size:0.85rem; color:var(--text-color);">
              <strong>📅 Target Local Schedule:</strong> ${escapeHtml(dateText)}<br/>
              <strong>📍 Detected Location:</strong> <code style="background:rgba(255,255,255,0.08); padding:2px 4px; border-radius:3px;">${escapeHtml(rawLoc || 'empty')}</code> &rarr; mapped to <strong>${escapeHtml(resolvedTz)}</strong>
            </div>
          `;
        }
      }
    }

    let html = tzHeader + `
      <div class="preview-subject">Subject: ${escapeHtml(subj)}</div>
      ${ccVal ? `<div class="preview-cc">Cc: ${escapeHtml(ccVal)}</div>` : ''}
      <div class="preview-body">${body || '<em style="opacity:.4">Body is empty</em>'}</div>
    `;

    const action = actionSel.value;
    if ((action === 'bulkSend' || action === 'threadedFollowup') && followupDrafts.length > 0) {
      followupDrafts.forEach((step, i) => {
        if (!step.bodyTemplate) return;
        const stepBody = replaceVars(buildFollowupTemplateHtml(step.bodyTemplate || ''), row);
        html += `
          <div style="margin: 20px 0; border-top: 1px dashed var(--surface-border); padding-top: 16px;">
             <strong>Follow-up ${i + 1}</strong> <small style="color:var(--text-dim)">(After ${step.dayOffset} days at ${step.time} — same thread/subject)</small>
          </div>
          <div class="preview-body">${stepBody || '<em style="opacity:.4">Body is empty</em>'}</div>
        `;
      });
    }

    previewPane.innerHTML = html;
    previewCount.textContent = `${previewIdx + 1} / ${rows.length}`;
    btnPrev.disabled = previewIdx <= 0;
    btnNext.disabled = previewIdx >= rows.length - 1;
  }

  btnPrev.addEventListener('click', () => { if (previewIdx > 0) { previewIdx--; renderPreview(); } });
  btnNext.addEventListener('click', () => { if (previewIdx < rows.length - 1) { previewIdx++; renderPreview(); } });
  subjectTpl.addEventListener('input', renderPreview);
  $('cc-emails')?.addEventListener('input', renderPreview);
  sigSelect.addEventListener('change', renderPreview);
  bodyEditor?.addEventListener('input', renderPreview);
  bodyEditor?.addEventListener('paste', (event) => {
    event.preventDefault();
    const html = event.clipboardData?.getData('text/html');
    const text = event.clipboardData?.getData('text/plain') || '';
    const cleaned = cleanPasteHtml(html, text);
    document.execCommand('insertHTML', false, cleaned);
    renderPreview();
  });
  bodyToolbar?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    runRichCommand(bodyEditor, button.dataset.command);
    renderPreview();
  });

  /* ──────────────────────────────────
     Multi-Signature Management
     ────────────────────────────────── */
  function fetchSignatures() {
    apiFetch('/api/users/signatures', { headers: { 'cookie': document.cookie } })
      .then(r => r.json())
      .then(data => {
        userSignatures = data || [];
        // Populate select
        const currentSelection = sigSelect.value;
        sigSelect.innerHTML = '<option value="">-- No Signature --</option>';
        userSignatures.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.name;
          sigSelect.appendChild(opt);
        });
        if (currentSelection && userSignatures.some(s => s.id === currentSelection)) {
          sigSelect.value = currentSelection;
        } else if (userSignatures.length > 0) {
          sigSelect.value = userSignatures[0].id;
        }
        renderPreview();
        renderSigList();
      }).catch(console.error);
  }

  function renderSigList() {
    if (!userSignatures.length) {
      sigList.innerHTML = '<li style="opacity:0.5;">No signatures found. Create one below!</li>';
      return;
    }
    sigList.innerHTML = userSignatures.map(s => `
      <li style="display:flex; justify-content:space-between; align-items:center; padding:0.5rem; border-bottom:1px solid var(--border-color);">
        <strong>${escapeHtml(s.name)}</strong>
        <div>
          <button class="btn btn-ghost btn-sm" onclick="window.editSig('${s.id}')">Edit</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="window.deleteSig('${s.id}')">Delete</button>
        </div>
      </li>
    `).join('');
  }

  btnManageSig.addEventListener('click', () => {
    sigModal.style.display = 'block';
    resetSigForm();
  });
  
  btnCloseSigModal.addEventListener('click', () => {
    sigModal.style.display = 'none';
  });

  window.editSig = (id) => {
    const s = userSignatures.find(x => x.id === id);
    if (!s) return;
    sigEditId.value = s.id;
    sigName.value = s.name;
    const bodyHtml = /<\/?[a-z][\s\S]*>/i.test(s.content) ? s.content : markdownToHtml(s.content);
    sigContent.innerHTML = bodyHtml;
    sigEditorTitle.textContent = 'Edit Signature';
    btnCancelEditSig.style.display = 'inline-block';
  };

  sigContent?.addEventListener('paste', (event) => {
    event.preventDefault();
    const html = event.clipboardData?.getData('text/html');
    const text = event.clipboardData?.getData('text/plain') || '';
    const cleaned = cleanPasteHtml(html, text);
    document.execCommand('insertHTML', false, cleaned);
  });
  
  sigToolbar?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    runRichCommand(sigContent, button.dataset.command);
  });

  window.deleteSig = (id) => {
    if (!confirm('Are you sure you want to delete this signature?')) return;
    apiFetch('/api/users/signatures', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    }).then(() => fetchSignatures());
  };

  btnCancelEditSig.addEventListener('click', resetSigForm);

  function resetSigForm() {
    sigEditId.value = '';
    sigName.value = '';
    if (sigContent) sigContent.innerHTML = '';
    sigEditorTitle.textContent = 'Add New Signature';
    btnCancelEditSig.style.display = 'none';
  }

  btnSaveSig.addEventListener('click', () => {
    const name = sigName.value.trim();
    const content = getEditorHtml(sigContent);
    if (!name || !content) return alert('Name and Content are required');
    
    btnSaveSig.disabled = true;
    apiFetch('/api/users/signatures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sigEditId.value || undefined, name, content })
    })
    .then(() => {
      resetSigForm();
      fetchSignatures();
    })
    .catch(err => alert('Error saving signature: ' + err.message))
    .finally(() => btnSaveSig.disabled = false);
  });

  /* ──────────────────────────────────
     Campaign Templates Manager (Google Docs)
     ────────────────────────────────── */
  let userTemplates = [];

  async function fetchTemplates() {
    try {
      const res = await apiFetch('/api/users/templates');
      if (!res.ok) throw new Error('Failed to fetch templates');
      userTemplates = await res.json();
      
      // Update template selection dropdown
      const selectedId = templateSelect.value;
      templateSelect.innerHTML = '<option value="">-- Start from Scratch --</option>' +
        userTemplates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
      
      // Restore selected value if it still exists
      if (userTemplates.some(t => t.id === selectedId)) {
        templateSelect.value = selectedId;
      } else {
        templateSelect.value = '';
      }
      
      renderTemplateList();
    } catch (err) {
      console.error('Error fetching templates:', err);
    }
  }

  function renderTemplateList() {
    if (!userTemplates.length) {
      templateList.innerHTML = '<li style="opacity:0.5; padding:8px;">No templates found. Save one below!</li>';
      return;
    }
    templateList.innerHTML = userTemplates.map(t => `
      <li style="display:flex; justify-content:space-between; align-items:center; padding:0.5rem; border-bottom:1px solid var(--border-color); gap: 10px;">
        <span style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 250px;">
          ${escapeHtml(t.name)}
        </span>
        <div style="display:flex; gap:6px;">
          <a href="${t.doc_url}" target="_blank" class="btn btn-ghost btn-sm" style="color:var(--primary-color);">📄 View Doc</a>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="window.deleteTemplate('${t.id}')">Delete</button>
        </div>
      </li>
    `).join('');
  }

  btnManageTemplates.addEventListener('click', () => {
    templateModal.style.display = 'block';
    templateName.value = '';
    templateSaveStatus.style.display = 'none';
  });

  btnCloseTemplateModal.addEventListener('click', () => {
    templateModal.style.display = 'none';
  });

  // Handle template selection change (load template)
  templateSelect.addEventListener('change', async () => {
    const templateId = templateSelect.value;
    if (!templateId) return; // Start from scratch
    
    const originalText = templateSelect.options[templateSelect.selectedIndex].text;
    templateSelect.options[templateSelect.selectedIndex].text = `⏳ Loading...`;
    templateSelect.disabled = true;
    
    try {
      const res = await apiFetch(`/api/users/templates?id=${templateId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load template');
      
      // Inject subject, CC, body
      subjectTpl.value = data.subjectTemplate || '';
      const ccEl = $('cc-emails');
      if (ccEl) ccEl.value = data.ccTemplate || '';
      
      if (bodyEditor) {
        bodyEditor.innerHTML = data.bodyTemplate || '';
      }
      
      // Inject follow-ups
      if (Array.isArray(data.followups)) {
        followupDrafts = data.followups;
        followupCount.value = data.followups.length;
      } else {
        followupDrafts = [];
        followupCount.value = 0;
      }
      
      // Rebuild and refresh follow-up UI and live preview
      renderFollowupBuilder();
      renderPreview();
      
    } catch (err) {
      console.error(err);
      alert('Error loading template: ' + err.message + '\n\nMake sure your Google authentication is active!');
    } finally {
      templateSelect.options[templateSelect.selectedIndex].text = originalText;
      templateSelect.disabled = false;
    }
  });

  // Save current composer state as template
  btnSaveTemplate.addEventListener('click', async () => {
    const name = templateName.value.trim();
    if (!name) return alert('Please enter a template name.');
    
    btnSaveTemplate.disabled = true;
    templateSaveStatus.style.color = 'var(--text-color)';
    templateSaveStatus.style.display = 'inline';
    templateSaveStatus.textContent = '⏳ Saving to Google Docs...';
    
    try {
      // Gather active composer values
      const subjectTemplate = subjectTpl.value || '';
      const ccTemplate = $('cc-emails')?.value || '';
      const bodyTemplate = getEditorHtml(bodyEditor);
      const followups = followupDrafts; // Sync is run on any input in the builder
      
      const res = await apiFetch('/api/users/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          subjectTemplate,
          bodyTemplate,
          ccTemplate,
          followups
        })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save template');
      
      templateSaveStatus.style.color = 'var(--success)';
      templateSaveStatus.textContent = '🟢 Saved successfully!';
      templateName.value = '';
      
      await fetchTemplates();
      
      // Pre-select the newly saved template in the dropdown
      if (data.id) {
        templateSelect.value = data.id;
      }
      
      setTimeout(() => {
        templateSaveStatus.style.display = 'none';
      }, 4000);
      
    } catch (err) {
      console.error(err);
      templateSaveStatus.style.color = 'var(--danger)';
      templateSaveStatus.textContent = '❌ Error saving template';
      alert('Error saving template: ' + err.message + '\n\nMake sure to sign out and log back in to authorize Google Docs API!');
    } finally {
      btnSaveTemplate.disabled = false;
    }
  });

  window.deleteTemplate = async (id) => {
    if (!confirm('Are you sure you want to delete this template index from Stroke?\n(The Google Doc will remain in your Google Drive for your safety)')) return;
    
    try {
      const res = await apiFetch('/api/users/templates', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete template');
      }
      await fetchTemplates();
    } catch (err) {
      console.error(err);
      alert('Error deleting template: ' + err.message);
    }
  };

  /* ──────────────────────────────────
     Action toggle
     ────────────────────────────────── */
  actionSel.addEventListener('change', () => {
    const v = actionSel.value;
    subjectGroup.style.display = v === 'bulkSend' ? '' : 'none';
    bodyGroup.style.display = v === 'checkReplies' ? 'none' : '';
    followupConfig.style.display = (v === 'bulkSend' || v === 'threadedFollowup') ? 'block' : 'none';
    // Toggle help text
    const helpBulk = document.getElementById('followup-help-bulk');
    const helpThreaded = document.getElementById('followup-help-threaded');
    if (helpBulk) helpBulk.style.display = v === 'bulkSend' ? '' : 'none';
    if (helpThreaded) helpThreaded.style.display = v === 'threadedFollowup' ? '' : 'none';
    const label = { bulkSend: 'Send Emails', threadedFollowup: 'Send Follow-ups', checkReplies: 'Check Replies' }[v];
    btnSend.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2 11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      ${label}
    `;
  });
  // Trigger change on load to show follow-up planner for default (bulkSend)
  actionSel.dispatchEvent(new Event('change'));

  function renderFollowupBuilder() {
    const count = Math.min(10, Math.max(0, parseInt(followupCount.value || '0', 10)));
    followupCount.value = count;
    const defaultDays = [1, 2, 3, 4, 5, 6, 7];
    followupList.innerHTML = Array.from({ length: count }, (_, i) => {
      const existing = followupDrafts[i] || {};
      const dayOffset = existing.dayOffset ?? defaultDays[i] ?? (defaultDays[defaultDays.length - 1] + 7 * (i - defaultDays.length + 1));
      const time = existing.time || '10:00';
      const body = existing.bodyTemplate || (i === 0
        ? 'Hi {{name}},\n\nFollowing up on my previous email.\n\nBest,\nYour Name'
        : 'Hi {{name}},\n\nSharing a quick follow-up in case this got buried.\n\nBest,\nYour Name');
      const bodyHtml = /<\/?[a-z][\s\S]*>/i.test(body)
        ? body
        : markdownToHtml(body);

      return `
      <div class="followup-item">
        <div class="followup-row">
          <strong>Follow-up ${i + 1}</strong>
          <label>After <input type="number" class="fu-days" data-idx="${i}" min="0" max="7" value="${dayOffset}" /> day(s)</label>
          <label>At <input type="time" class="fu-time" data-idx="${i}" value="${time}" /></label>
        </div>
        <div class="field">
          <label>Body</label>
          <div class="rich-editor followup-editor-wrap">
            <div class="rich-toolbar followup-toolbar" data-idx="${i}">
              <button class="icon-btn toolbar-btn" type="button" data-command="bold" title="Bold"><strong>B</strong></button>
              <button class="icon-btn toolbar-btn" type="button" data-command="italic" title="Italic"><em>I</em></button>
              <button class="icon-btn toolbar-btn" type="button" data-command="underline" title="Underline"><span style="text-decoration:underline;">U</span></button>
              <button class="icon-btn toolbar-btn" type="button" data-command="insertUnorderedList" title="Bulleted list">&bull;</button>
              <button class="icon-btn toolbar-btn" type="button" data-command="insertOrderedList" title="Numbered list">1.</button>
              <button class="icon-btn toolbar-btn" type="button" data-command="createLink" title="Add hyperlink">Link</button>
              <button class="icon-btn toolbar-btn" type="button" data-command="removeFormat" title="Clear formatting">Clear</button>
            </div>
            <div class="rich-input fu-body" contenteditable="true" data-idx="${i}" data-placeholder="Write and format follow-up ${i + 1} here.">${bodyHtml}</div>
          </div>
        </div>
      </div>`;
    }).join('');

    const sync = () => {
      followupDrafts = Array.from({ length: count }, (_, i) => ({
        dayOffset: Number(followupList.querySelector(`.fu-days[data-idx="${i}"]`)?.value || 0),
        time: followupList.querySelector(`.fu-time[data-idx="${i}"]`)?.value || '10:00',
        bodyTemplate: getEditorHtml(followupList.querySelector(`.fu-body[data-idx="${i}"]`))
      }));
      renderPreview();
    };
    followupList.querySelectorAll('input').forEach(el => el.addEventListener('input', sync));
    followupList.querySelectorAll('.fu-body').forEach(editor => {
      editor.addEventListener('input', sync);
      editor.addEventListener('paste', (event) => {
        event.preventDefault();
        const html = event.clipboardData?.getData('text/html');
        const text = event.clipboardData?.getData('text/plain') || '';
        const cleaned = cleanPasteHtml(html, text);
        document.execCommand('insertHTML', false, cleaned);
        sync();
      });
    });
    followupList.querySelectorAll('.followup-toolbar').forEach(toolbar => {
      toolbar.addEventListener('click', (event) => {
        const button = event.target.closest('[data-command]');
        if (!button) return;
        const idx = toolbar.dataset.idx;
        const editor = followupList.querySelector(`.fu-body[data-idx="${idx}"]`);
        runRichCommand(editor, button.dataset.command);
        sync();
      });
    });
    sync();
  }
  followupCount?.addEventListener('input', renderFollowupBuilder);
  renderFollowupBuilder();

  // Timing toggle logic  (All times are IST = UTC+05:30)
  const timingRadios = document.querySelectorAll('input[name="sendTiming"]');
  const scheduleTimeInput = $('schedule-time');
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  /** Get current moment shifted into IST space (use getUTC* methods on result) */
  function nowIST() { return new Date(Date.now() + IST_OFFSET_MS); }

  /** Format an IST-shifted Date as YYYY-MM-DDTHH:MM for datetime-local inputs */
  function toISTString(d) {
    const pad = n => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  }

  /** Parse a datetime-local value as IST and return UTC ISO string */
  function istInputToUTC(val) { return new Date(val + ':00+05:30').toISOString(); }

  /** Parse a datetime-local value as IST and return a Date object */
  function istInputToDate(val) { return new Date(val + ':00+05:30'); }

  const scheduleTzHint = $('schedule-tz-hint');
  timingRadios.forEach(r => r.addEventListener('change', () => {
    if (r.value === 'schedule') {
      scheduleTimeInput.style.display = 'block';
      if (scheduleTzHint) scheduleTzHint.style.display = enableLocalTz && enableLocalTz.checked ? 'none' : 'block';
      if (tzSettingsGroup) tzSettingsGroup.style.display = 'block';
      // Pre-populate with 1 hour from now in IST, rounded to next 5 min
      const defIST = new Date(nowIST().getTime() + 60 * 60 * 1000);
      defIST.setUTCMinutes(Math.ceil(defIST.getUTCMinutes() / 5) * 5, 0, 0);
      scheduleTimeInput.value = toISTString(defIST);
      // Set min to current IST so browser blocks past times
      scheduleTimeInput.min = toISTString(nowIST());
    } else {
      scheduleTimeInput.style.display = 'none';
      if (scheduleTzHint) scheduleTzHint.style.display = 'none';
      if (tzSettingsGroup) tzSettingsGroup.style.display = 'none';
    }
    renderPreview();
  }));

  // Toggle local timezone sub-options and preview recalculations
  enableLocalTz?.addEventListener('change', () => {
    const isChecked = enableLocalTz.checked;
    if (tzLocalOptions) tzLocalOptions.style.display = isChecked ? 'flex' : 'none';
    if (scheduleTzHint) scheduleTzHint.style.display = isChecked ? 'none' : 'block';
    renderPreview();
  });

  tzColumnSelect?.addEventListener('change', () => {
    renderPreview();
  });

  /* ──────────────────────────────────
     Schedule Campaign via Backend
     ────────────────────────────────── */

  // Close verification modal
  btnCloseTzModal?.addEventListener('click', () => {
    tzVerificationModal.style.display = 'none';
  });

  btnCancelTzVerification?.addEventListener('click', () => {
    tzVerificationModal.style.display = 'none';
  });

  btnConfirmTzLaunch?.addEventListener('click', () => {
    const verifiedMappings = {};
    tzVerificationTbody.querySelectorAll('.tz-mapping-select').forEach(sel => {
      const loc = sel.dataset.location;
      verifiedMappings[loc] = sel.value;
    });
    launchCampaign(verifiedMappings);
  });

  btnSend.addEventListener('click', async () => {
    if (!user) { alert('Please sign in with Google first.'); return; }
    if (!rows.length) { alert('Upload a CSV file first.'); return; }

    const action = actionSel.value;
    const isSchedule = document.querySelector('input[name="sendTiming"]:checked').value === 'schedule';
    const scheduleInput = isSchedule ? scheduleTimeInput.value : '';

    // Validate scheduled time
    if (scheduleInput) {
      const scheduledDate = new Date(scheduleInput);
      const now = new Date();
      if (scheduledDate <= now) {
        alert('The scheduled time must be in the future.\n\nPlease pick a later date/time or use "Send Instantly".');
        return;
      }
    }

    // Check if recipient local timezone is enabled
    if (isSchedule && enableLocalTz && enableLocalTz.checked) {
      const colName = tzColumnSelect.value;
      if (!colName) { alert('Please select a Location CSV Column.'); return; }
      const colIdx = headers.indexOf(colName);
      if (colIdx === -1) { alert('Selected location column is not found in the CSV.'); return; }
      
      const verifyEnabled = verifyTimezones && verifyTimezones.checked;
      if (verifyEnabled) {
        // Extract unique locations from CSV
        const uniqueLocations = [...new Set(rows.map(row => (row[colIdx] || '').trim()))];
        
        // Render verification rows
        tzVerificationTbody.innerHTML = uniqueLocations.map((loc, idx) => {
          const resolvedTz = resolveTimezoneName(loc);
          const tzOptions = [
            'Asia/Kolkata', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'UTC',
            'America/Los_Angeles', 'America/Chicago', 'Australia/Sydney', 'Asia/Singapore',
            'Asia/Dubai', 'Europe/Paris', 'Europe/Berlin', 'America/Toronto',
            'America/Denver', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu',
            'Europe/Moscow', 'Asia/Hong_Kong', 'Asia/Seoul'
          ];
          
          if (!tzOptions.includes(resolvedTz)) {
            tzOptions.unshift(resolvedTz);
          }
          
          const dropdownHtml = `
            <div class="select-wrap" style="height:32px; min-width:200px;">
              <select class="tz-mapping-select" data-location="${escapeHtml(loc)}" style="padding:4px 8px; font-size:0.85rem;">
                ${tzOptions.map(tz => `<option value="${tz}" ${tz === resolvedTz ? 'selected' : ''}>${escapeHtml(tz)}</option>`).join('')}
              </select>
            </div>
          `;
          
          return `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
              <td style="padding:10px; font-weight:500;">${escapeHtml(loc || '(empty/blank)')}</td>
              <td style="padding:10px; color:var(--text-dim);"><span id="tz-badge-${idx}" style="background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:3px; font-size:0.8rem;">${escapeHtml(resolvedTz)}</span></td>
              <td style="padding:10px;">${dropdownHtml}</td>
            </tr>
          `;
        }).join('');
        
        // Setup change badges on mapping selects
        tzVerificationTbody.querySelectorAll('.tz-mapping-select').forEach((sel, idx) => {
          sel.addEventListener('change', () => {
            const badge = document.getElementById(`tz-badge-${idx}`);
            if (badge) badge.textContent = sel.value;
          });
        });
        
        // Open modal and wait for confirm click
        tzVerificationModal.style.display = 'block';
        return;
      } else {
        // Auto-map without manual verification
        const autoMappings = {};
        rows.forEach(row => {
          const loc = (row[colIdx] || '').trim();
          autoMappings[loc] = resolveTimezoneName(loc);
        });
        launchCampaign(autoMappings);
      }
    } else {
      // Standard route (IST scheduled offset or immediate)
      launchCampaign(null);
    }
  });

  async function launchCampaign(verifiedMappings) {
    if (tzVerificationModal) tzVerificationModal.style.display = 'none';

    const action = actionSel.value;
    const isSchedule = document.querySelector('input[name="sendTiming"]:checked').value === 'schedule';
    const scheduleInput = isSchedule ? scheduleTimeInput.value : '';
    
    // In local timezone mode, scheduleInput is passed directly as a wall-clock local time!
    // Otherwise, we parse it through istInputToUTC
    const isLocalTz = isSchedule && enableLocalTz && enableLocalTz.checked;
    const scheduledAt = scheduleInput 
      ? (isLocalTz ? scheduleInput : istInputToUTC(scheduleInput)) 
      : new Date().toISOString();

    btnSend.disabled = true;
    progressArea.style.display = 'block';
    resultsArea.style.display = 'none';
    progressFill.style.background = '';
    progressFill.style.width = '30%';
    progressText.textContent = scheduleInput ? 'Scheduling campaign...' : 'Sending immediately...';

    try {
      const fullBody = buildEmailTemplateHtml();
      const payload = {
        action,
        subjectTemplate: subjectTpl.value,
        bodyTemplate: fullBody,
        ccTemplate: $('cc-emails')?.value || '',
        csvData: rows,
        headers: headers,
        scheduledAt,
        timezoneMode: isLocalTz ? 'recipient' : 'global',
        timezoneColumn: isLocalTz ? tzColumnSelect.value : null,
        timezoneMappings: verifiedMappings || null
      };

      if (action === 'threadedFollowup') {
        const hasThreadId = headers.some(h => String(h).toLowerCase().includes('threadid'));
        if (!hasThreadId) throw new Error("For follow-ups, upload send log CSV that contains 'threadId'.");
        payload.followups = followupDrafts.length ? followupDrafts.map(step => ({
          ...step,
          bodyTemplate: buildFollowupTemplateHtml(step.bodyTemplate || '')
        })) : [{
          isImplicit: true,
          subjectTemplate: subjectTpl.value || 'Follow up',
          bodyTemplate: fullBody
        }];
      }

      // Attach follow-ups for bulkSend if user configured any
      if (action === 'bulkSend' && followupDrafts.length > 0) {
        const nonEmptyFollowups = followupDrafts.filter(step =>
          step.bodyTemplate || step.subjectTemplate
        );
        if (nonEmptyFollowups.length > 0) {
          payload.followups = nonEmptyFollowups.map(step => ({
            ...step,
            bodyTemplate: buildFollowupTemplateHtml(step.bodyTemplate || '')
          }));
        }
      }

      const res = await apiFetch('/api/campaigns/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');

      progressFill.style.width = '100%';
      progressText.textContent = `✅ Success! ${data.count} emails queued/scheduled.`;
      
      const msg = scheduleInput 
        ? `Campaign successfully scheduled.\n\nThe server will run automatically in the background — you can safely close this tab.` 
        : 'Campaign added to the queue! Processing them immediately...';
        
      alert(msg);

      // If scheduled for "right now", trigger the processing worker immediately!
      if (!scheduleInput) {
         apiFetch('/api/cron/process').catch(e => console.error('Immediate processing trigger info:', e));
      }

    } catch (err) {
      progressFill.style.width = '100%';
      progressFill.style.background = 'var(--danger)';
      progressText.textContent = '❌ Error: ' + err.message;
    } finally {
      btnSend.disabled = false;
    }
  }

  /* ──────────────────────────────────
     Helpers
     ────────────────────────────────── */

  function findCol(fragment) {
    return headers.findIndex(h => h.trim().toLowerCase().includes(fragment.toLowerCase()));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ──────────────────────────────────
     Results table
     ────────────────────────────────── */
  function renderResults(data) {
    if (!data.length) return;
    resultsArea.style.display = 'block';
    const keys = Object.keys(data[0]);
    resultsThead.innerHTML = keys.map(k => `<th>${k}</th>`).join('');
    resultsTbody.innerHTML = data.map(row =>
      '<tr>' + keys.map(k => {
        const val = row[k] ?? '';
        let cls = '';
        if (k === 'status') cls = `status-${val}`;
        return `<td class="${cls}">${val}</td>`;
      }).join('') + '</tr>'
    ).join('');
  }

  /* ──────────────────────────────────
     Campaign Management
     ────────────────────────────────── */
  function fetchCampaigns() {
    apiFetch('/api/campaigns/list', { headers: { 'cookie': document.cookie } })
      .then(r => r.json())
      .then(data => {
         if (data.error) throw new Error(data.error);
         renderCampaigns(data || []);
      })
      .catch(e => {
         campaignsTbody.innerHTML = `<tr><td colspan="5" style="color:var(--danger)">Failed to load campaigns: ${escapeHtml(e.message)}</td></tr>`;
      });
  }

  function renderCampaigns(campaigns) {
    if (!campaigns.length) {
      campaignsTbody.innerHTML = `<tr><td colspan="5" style="text-align:center; opacity:0.5;">No campaigns found.</td></tr>`;
      return;
    }
    window.allCampaignsData = campaigns;
    campaignsTbody.innerHTML = campaigns.map(c => {
       const actionMap = { bulkSend: 'Bulk Blast', threadedFollowup: 'Thread Follow-up', checkReplies: 'Inbox Check' };
       const type = actionMap[c.action] || c.action;
       
       let manageBtn = `<div style="display:flex; gap:10px; align-items:center;">
          <a href="${STROKE_API_BASE}/api/campaigns/export?campaignId=${c.id}" target="_blank" class="btn btn-ghost btn-sm" title="Download Send Log (includes threadId)">⬇ CSV</a>
          <button class="btn btn-ghost btn-sm" onclick="window.backupToGoogleSheets('${c.id}', this)" title="Backup to Google Sheets">☁️ Backup</button>
          <button class="btn btn-ghost btn-sm" onclick="window.backupToGoogleDocs('${c.id}', this)" title="Outline to Google Docs">📄 Docs</button>`;
          
       if (c.status !== 'cancelled' && (c.pending > 0)) {
          manageBtn += `<button class="btn btn-ghost btn-sm" onclick="window.openEditCampaign('${c.id}')">Edit</button></div>`;
       } else {
          manageBtn += `<span style="opacity:0.5; font-size:0.8rem;">Finished</span></div>`;
       }
       
       return `<tr>
         <td><strong>${escapeHtml(type)}</strong></td>
         <td><span class="status-${c.status}">${escapeHtml(c.status)}</span></td>
         <td>${c.sent || 0} Sent / ${c.pending || 0} Pend</td>
         <td>${new Date(c.created_at).toLocaleString()}</td>
         <td>${manageBtn}</td>
       </tr>`;
    }).join('');
  }

  window.openEditCampaign = (id) => {
    const c = (window.allCampaignsData || []).find(x => x.id === id);
    if (!c) return;
    editCampId.value = c.id;
    editCampSubject.value = c.subject_template || '';
    if ($('edit-camp-cc')) {
      $('edit-camp-cc').value = c.cc_template || '';
    }
    editCampBody.innerHTML = c.body_template ? (/<\/?[a-z][\s\S]*>/i.test(c.body_template) ? c.body_template : markdownToHtml(c.body_template)) : '';
    editCampStatus.textContent = '';
    
    currentEditFollowups = c.followup_config || [];
    if (currentEditFollowups.length > 0) {
      editCampFollowupsContainer.style.display = 'block';
      editCampFollowupsList.innerHTML = currentEditFollowups.map((step, i) => {
        const bodyContent = step.bodyTemplate ? (/<\/?[a-z][\s\S]*>/i.test(step.bodyTemplate) ? step.bodyTemplate : markdownToHtml(step.bodyTemplate)) : '';
        return `
          <div class="edit-fu-item">
            <div style="margin-bottom:5px;"><strong>Follow-up ${i+1}</strong> <small style="color:var(--text-dim)">(After ${step.dayOffset} days)</small></div>
            <div class="rich-editor">
              <div class="rich-toolbar edit-fu-toolbar" data-idx="${i}">
                <button class="icon-btn toolbar-btn" type="button" data-command="bold"><strong>B</strong></button>
                <button class="icon-btn toolbar-btn" type="button" data-command="italic"><em>I</em></button>
                <button class="icon-btn toolbar-btn" type="button" data-command="underline"><span style="text-decoration:underline;">U</span></button>
                <button class="icon-btn toolbar-btn" type="button" data-command="createLink">Link</button>
                <button class="icon-btn toolbar-btn" type="button" data-command="removeFormat">Clear</button>
              </div>
              <div class="rich-input edit-fu-body" contenteditable="true" data-idx="${i}" style="min-height:80px;">${bodyContent}</div>
            </div>
          </div>
        `;
      }).join('');
      
      editCampFollowupsList.querySelectorAll('.edit-fu-toolbar').forEach(toolbar => {
        toolbar.addEventListener('click', (event) => {
          const button = event.target.closest('[data-command]');
          if (!button) return;
          const idx = toolbar.dataset.idx;
          const editor = editCampFollowupsList.querySelector(`.edit-fu-body[data-idx="${idx}"]`);
          runRichCommand(editor, button.dataset.command);
        });
      });
      
    } else {
      editCampFollowupsContainer.style.display = 'none';
      editCampFollowupsList.innerHTML = '';
    }

    // Fetch individual recipients
    if (editCampRecipientsList) {
      editCampRecipientsList.innerHTML = `<div style="text-align:center; opacity:0.5; padding:1rem; font-size:0.9rem;">Loading recipients...</div>`;
      editCampRecipientsSearch.value = '';
      currentEditEmails = [];
      
      apiFetch(`/api/campaigns/emails?campaignId=${c.id}`)
        .then(res => {
          if (!res.ok) throw new Error('Failed to fetch recipients');
          return res.json();
        })
        .then(emails => {
          currentEditEmails = emails;
          renderEditCampaignRecipients(emails);
        })
        .catch(err => {
          console.error(err);
          editCampRecipientsList.innerHTML = `<div style="text-align:center; color:var(--danger); padding:1rem; font-size:0.9rem;">Failed to load recipients</div>`;
        });
    }

    btnCancelCampaign.style.display = 'inline-block';
    btnSaveCampaign.disabled = false;
    editCampModal.style.display = 'block';
  };

  function renderEditCampaignRecipients(emails, filterText = '') {
    if (!editCampRecipientsList) return;
    
    const query = filterText.toLowerCase().trim();
    const filtered = emails.filter(e => e.to_email.toLowerCase().includes(query));
    
    if (filtered.length === 0) {
      editCampRecipientsList.innerHTML = `<div style="text-align:center; opacity:0.5; padding:1rem; font-size:0.9rem;">No matching recipients found.</div>`;
      return;
    }
    
    editCampRecipientsList.innerHTML = filtered.map(email => {
      const isPending = email.status === 'pending';
      const isPaused = email.status === 'paused';
      const isCancelled = email.status === 'cancelled';
      
      let controlsHtml = '';
      if (isPending) {
        controlsHtml = `
          <button class="btn-control btn-control-pause" onclick="window.updateEmailStatus('${email.id}', 'paused')">Pause ⏸</button>
          <button class="btn-control btn-control-cancel" onclick="window.updateEmailStatus('${email.id}', 'cancelled')">Cancel ✕</button>
        `;
      } else if (isPaused) {
        controlsHtml = `
          <button class="btn-control btn-control-resume" onclick="window.updateEmailStatus('${email.id}', 'pending')">Resume ▶</button>
          <button class="btn-control btn-control-cancel" onclick="window.updateEmailStatus('${email.id}', 'cancelled')">Cancel ✕</button>
        `;
      } else if (isCancelled) {
        controlsHtml = `<span style="font-size:0.75rem; color:var(--text-dim);">Cancelled</span>`;
      } else {
        let statusLabel = email.status;
        if (email.status === 'skipped_replied') statusLabel = 'Replied (Skipped)';
        if (email.status === 'sent') statusLabel = 'Sent ✓';
        if (email.status === 'failed') statusLabel = 'Failed ✕';
        controlsHtml = `<span style="font-size:0.75rem; color:var(--text-muted);">${statusLabel}</span>`;
      }

      let metaText = '';
      if (email.status === 'pending' || email.status === 'paused') {
        const dateStr = email.scheduled_at ? new Date(email.scheduled_at).toLocaleString() : 'N/A';
        metaText = `Scheduled: ${dateStr}`;
      } else if (email.status === 'sent') {
        const dateStr = email.sent_at ? new Date(email.sent_at).toLocaleString() : 'N/A';
        metaText = `Sent: ${dateStr}`;
      } else if (email.status === 'failed') {
        metaText = `Error: ${email.error || 'Unknown error'}`;
      } else if (email.status === 'skipped_replied') {
        metaText = `Replied - skipped further follow-ups`;
      } else if (email.status === 'cancelled') {
        metaText = `Cancelled outreach`;
      }
      
      const stepBadge = email.is_followup ? `<span style="font-size:0.7rem; background:rgba(255,255,255,0.1); padding:1px 4px; border-radius:3px; margin-right:4px;">Follow-up</span>` : `<span style="font-size:0.7rem; background:rgba(255,255,255,0.05); padding:1px 4px; border-radius:3px; margin-right:4px;">Initial</span>`;

      return `
        <div class="edit-recip-item">
          <div class="edit-recip-info">
            <div class="edit-recip-email">${email.to_email}</div>
            <div class="edit-recip-meta">
              ${stepBadge}
              <span>${metaText}</span>
            </div>
          </div>
          <div class="edit-recip-controls" id="controls-${email.id}">
            <span class="status-${email.status}" style="margin-right:8px; font-size:0.8rem;">${email.status.toUpperCase()}</span>
            ${controlsHtml}
          </div>
        </div>
      `;
    }).join('');
  }

  window.updateEmailStatus = async (emailId, status) => {
    const controlsDiv = document.getElementById(`controls-${emailId}`);
    if (!controlsDiv) return;

    const originalHtml = controlsDiv.innerHTML;
    controlsDiv.innerHTML = `<span style="font-size:0.8rem; color:var(--text-muted);">Updating...</span>`;

    try {
      const res = await apiFetch('/api/campaigns/emails/update-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId, status })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to update status');
      }

      const idx = currentEditEmails.findIndex(e => e.id === emailId);
      if (idx !== -1) {
        currentEditEmails[idx].status = status;
      }

      const searchVal = editCampRecipientsSearch ? editCampRecipientsSearch.value : '';
      renderEditCampaignRecipients(currentEditEmails, searchVal);

      fetchCampaigns();

    } catch (err) {
      console.error(err);
      alert('Error updating status: ' + err.message);
      controlsDiv.innerHTML = originalHtml;
    }
  };

  window.backupToGoogleSheets = async (campaignId, buttonEl) => {
    const originalHtml = buttonEl.innerHTML;
    buttonEl.disabled = true;
    buttonEl.innerHTML = `⏳ Backing up...`;

    try {
      const res = await apiFetch('/api/campaigns/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create sheet');

      buttonEl.innerHTML = `🟢 Sheet Created!`;
      buttonEl.classList.remove('btn-ghost');
      buttonEl.classList.add('btn-primary');
      
      window.open(data.url, '_blank');
      
      setTimeout(() => {
        buttonEl.innerHTML = originalHtml;
        buttonEl.classList.add('btn-ghost');
        buttonEl.classList.remove('btn-primary');
        buttonEl.disabled = false;
      }, 5000);

    } catch (err) {
      console.error(err);
      alert('Error backing up to Google Sheets: ' + err.message + '\n\nMake sure to sign out and log back in to authorize the Google Sheets permissions!');
      buttonEl.innerHTML = originalHtml;
      buttonEl.disabled = false;
    }
  };

  window.backupToGoogleDocs = async (campaignId, buttonEl) => {
    const originalHtml = buttonEl.innerHTML;
    buttonEl.disabled = true;
    buttonEl.innerHTML = `⏳ Backing up...`;

    try {
      const res = await apiFetch('/api/campaigns/backup-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create doc');

      buttonEl.innerHTML = `🟢 Doc Created!`;
      buttonEl.classList.remove('btn-ghost');
      buttonEl.classList.add('btn-primary');
      
      window.open(data.url, '_blank');
      
      setTimeout(() => {
        buttonEl.innerHTML = originalHtml;
        buttonEl.classList.add('btn-ghost');
        buttonEl.classList.remove('btn-primary');
        buttonEl.disabled = false;
      }, 5000);

    } catch (err) {
      console.error(err);
      alert('Error outlining to Google Docs: ' + err.message + '\n\nMake sure to sign out and log back in to authorize the Google Docs permissions!');
      buttonEl.innerHTML = originalHtml;
      buttonEl.disabled = false;
    }
  };

  editCampRecipientsSearch?.addEventListener('input', (e) => {
    renderEditCampaignRecipients(currentEditEmails, e.target.value);
  });

  btnCloseEditModal.addEventListener('click', () => { editCampModal.style.display = 'none'; });

  editCampToolbar?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    runRichCommand(editCampBody, button.dataset.command);
  });
  
  editCampBody?.addEventListener('paste', (event) => {
    event.preventDefault();
    const html = event.clipboardData?.getData('text/html');
    const text = event.clipboardData?.getData('text/plain') || '';
    const cleaned = cleanPasteHtml(html, text);
    document.execCommand('insertHTML', false, cleaned);
  });

  btnSaveCampaign.addEventListener('click', async () => {
    const campaignId = editCampId.value;
    const subjectTemplate = editCampSubject.value.trim();
    const ccTemplate = $('edit-camp-cc')?.value.trim() || '';
    const bodyTemplate = getEditorHtml(editCampBody);
    
    if (!subjectTemplate && !bodyTemplate && !ccTemplate) return alert('Templates cannot be completely empty.');

    const updatedFollowups = currentEditFollowups.map((step, i) => {
       const editor = editCampFollowupsList.querySelector(`.edit-fu-body[data-idx="${i}"]`);
       return {
          ...step,
          bodyTemplate: getEditorHtml(editor)
       };
    });
    
    btnSaveCampaign.disabled = true;
    editCampStatus.textContent = 'Updating pending emails...';
    
    try {
       const res = await apiFetch('/api/campaigns/update', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ 
           campaignId, 
           subjectTemplate, 
           bodyTemplate, 
           ccTemplate,
           followups: currentEditFollowups.length ? updatedFollowups : undefined 
         })
       });
       const data = await res.json();
       if (!res.ok) throw new Error(data.error || 'Server error');
       
       editCampStatus.textContent = `✅ Updated ${data.updatedEmails} emails`;
       fetchCampaigns(); // refresh list
       setTimeout(() => { editCampModal.style.display = 'none'; }, 2000);
    } catch(err) {
       editCampStatus.textContent = `❌ Error: ${err.message}`;
       btnSaveCampaign.disabled = false;
    }
  });

  btnCancelCampaign.addEventListener('click', async () => {
    if (!confirm('Are you absolutely sure? This will prematurely cancel all pending emails in this campaign.')) return;
    try {
      btnCancelCampaign.disabled = true;
      const res = await apiFetch('/api/campaigns/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: editCampId.value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to cancel');
      editCampModal.style.display = 'none';
      fetchCampaigns();
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      btnCancelCampaign.disabled = false;
    }
  });

});
