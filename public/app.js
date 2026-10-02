const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

let current = null;
const busySessions = new Set();
let attachedFiles = [];
let pollTimer = null;
let activeRunBody = null;
const stepRows = new Map();

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 2800);
}
function formatMessage(value) {
  return escapeHtml(value)
    .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
}
async function api(route, options = {}) {
  const response = await fetch(`/api${route}`, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}

async function init() {
  try {
    const { models, configured } = await api('/models');
    $('#modelSelect').innerHTML = models.map(model => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>`).join('');
    $('#modelSelect').value = models[0]?.id || '';
    $('#envLabel').textContent = configured ? '已连接' : '待配置';
    $('#envSub').textContent = configured ? 'Token Plan 模型可用' : '请配置服务端模型凭据';
    const params = new URLSearchParams(location.search);
    const target = params.get('session');
    await refreshSessions();
    const list = await api('/sessions');
    if (target && list.some(session => session.id === target)) await openSession(target);
    else if (list.length) await openSession(list[0].id);
    else await newSession(false);
  } catch (error) { toast(error.message); }
}

async function refreshSessions() {
  const sessions = await api('/sessions');
  $('#sessionList').innerHTML = sessions.map(session => `<div class="session-row"><button class="session-entry ${current?.id === session.id ? 'active' : ''}" data-session="${session.id}" title="${escapeHtml(session.title)}"><span>${escapeHtml(session.title)}</span></button><button class="session-delete" data-delete="${session.id}" title="删除对话" aria-label="删除对话">×</button></div>`).join('');
  $$('[data-session]').forEach(button => button.onclick = () => openSession(button.dataset.session));
  $$('[data-delete]').forEach(button => button.onclick = async () => {
    if (!confirm('删除此对话及其云端电脑？此操作无法撤销。')) return;
    try {
      await api(`/sessions/${button.dataset.delete}`, { method: 'DELETE' });
      if (current?.id === button.dataset.delete) await newSession(false);
      await refreshSessions();
    } catch (error) { toast(error.message); }
  });
}

function clearTaskView() {
  clearInterval(pollTimer); pollTimer = null; stepRows.clear(); activeRunBody = null;
  $('#messages').innerHTML = ''; $('#activityList').innerHTML = ''; $('#activityCount').textContent = '0';
  $('#deliverables').innerHTML = '<div class="activity-title">交付内容</div><div class="deliverable-empty">完成的文件会出现在这里</div>';
  $('#messages').classList.remove('has-messages'); $('#welcome').style.display = '';
  $('#taskPane .empty-task').classList.remove('hidden');
}
function setBusy(value) {
  const id = current?.id;
  if (id) value ? busySessions.add(id) : busySessions.delete(id);
  const active = Boolean(id && busySessions.has(id));
  $('#sendButton').disabled = active; $('#stopTaskButton').classList.toggle('hidden', !active);
}
function sessionUI(session) {
  current = session; clearTaskView(); setBusy(Boolean(session.activeTask));
  $('#crumbTitle').textContent = session.title || '新任务';
  $('#desktopFrame').innerHTML = '<div class="desktop-placeholder"><div class="desktop-icon">▣</div><b>Orbit 云端电脑</b><p>每个对话拥有一台独立的 Ubuntu 22.04 桌面。Orbit 可在其中浏览网页、运行代码和创建文件。</p><button id="startDesktop" class="primary-button">启动桌面</button><small id="desktopNote">首次启动可能需要片刻</small></div>';
  $('#startDesktop').onclick = startDesktop;
  $('#desktopPane').classList.add('hidden'); $('#taskPane').classList.remove('hidden');
  $$('.inspector-tab').forEach(tab => tab.classList.toggle('selected', tab.dataset.tab === 'task'));
  for (const message of session.messages || []) addMessage(message.role, message.content, message.attachments);
  for (const task of session.tasks || []) {
    addActivity(task.title, task.status, `${task.model || 'Orbit'} · ${new Date(task.startedAt).toLocaleString()}`);
    (task.steps || []).forEach(showStep);
  }
  if (session.activeTask) {
    activeRunBody = addMessage('assistant', session.activeTask.assistantText || '');
    watchTask(session.id, session.activeTask.id);
  }
  refreshFiles(session.id); refreshSessions();
}

function addMessage(role, text, attachments = []) {
  $('#welcome').style.display = 'none';
  const list = $('#messages'); list.classList.add('has-messages');
  const row = document.createElement('div'); row.className = `message ${role === 'user' ? 'user' : 'assistant'}`;
  const attachmentTags = attachments?.length ? `<div class="message-attachments">${attachments.map(file => `<span>▤ ${escapeHtml(file.name)}</span>`).join('')}</div>` : '';
  row.innerHTML = `<div class="msg-avatar">${role === 'user' ? 'O' : '✳'}</div><div class="message-body">${formatMessage(text || '')}${attachmentTags}</div>`;
  list.append(row); list.scrollTop = list.scrollHeight;
  return row.querySelector('.message-body');
}
function addActivity(title, status = 'running', extra = '') {
  $('#taskPane .empty-task').classList.add('hidden');
  const row = document.createElement('div'); row.className = `activity-item ${status === 'complete' ? 'complete' : ''}`;
  row.innerHTML = `<i></i><div>${escapeHtml(title)}${extra ? `<small>${escapeHtml(extra)}</small>` : ''}</div>`;
  $('#activityList').append(row); $('#activityCount').textContent = $('#activityList').children.length;
  return row;
}
function showStep(step) {
  let row = stepRows.get(step.id);
  if (!row) {
    row = addActivity(step.title || step.tool || '执行步骤', step.status, step.tool ? `工具 · ${step.tool}` : '');
    stepRows.set(step.id, row);
  }
  row.classList.toggle('complete', step.status === 'complete');
  let chip = step.id && document.querySelector(`[data-step="${CSS.escape(step.id)}"]`);
  if (!chip) {
    chip = document.createElement('div'); chip.className = 'step-chip'; chip.dataset.step = step.id || '';
    chip.innerHTML = '<i class="step-dot"></i><span></span>'; $('#messages').append(chip);
  }
  chip.classList.toggle('done', step.status === 'complete'); chip.querySelector('span').textContent = step.title || step.tool || '执行步骤';
  if (step.result) {
    let output = document.querySelector(`[data-output="${CSS.escape(step.id)}"]`);
    if (!output) { output = document.createElement('pre'); output.className = 'step-output'; output.dataset.output = step.id; $('#messages').append(output); }
    output.textContent = String(step.result).slice(0, 1800);
  }
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

async function refreshFiles(sessionId = current?.id) {
  if (!sessionId) return;
  try {
    const files = await api(`/sessions/${sessionId}/files`);
    if (current?.id !== sessionId) return;
    $('#deliverables').innerHTML = `<div class="activity-title">交付内容 <span>${files.length}</span></div>` + (files.length
      ? files.map(file => `<a class="deliverable-link" href="/api/sessions/${sessionId}/download?path=${encodeURIComponent(file.path)}"><span class="file-icon">▤</span><span><b>${escapeHtml(file.name)}</b><small>${file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`}</small></span><i>↓</i></a>`).join('')
      : '<div class="deliverable-empty">完成的文件会出现在这里</div>');
  } catch {}
}
async function openSession(id) {
  try { sessionUI(await api(`/sessions/${id}`)); history.replaceState(null, '', `?session=${encodeURIComponent(id)}`); }
  catch (error) { toast(error.message); }
}
async function newSession(focus = true) {
  try {
    const session = await api('/sessions', { method: 'POST' }); sessionUI(session);
    history.replaceState(null, '', `?session=${encodeURIComponent(session.id)}`);
    if (focus) $('#prompt').focus();
    if (session.desktopState && session.desktopState !== 'available') $('#envSub').textContent = '桌面初始化中';
  } catch (error) { toast(error.message); }
}

function watchTask(sessionId, taskId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const session = await api(`/sessions/${sessionId}`);
      if (current?.id !== sessionId) return;
      const task = session.activeTask;
      if (!task || task.id !== taskId) {
        clearInterval(pollTimer); pollTimer = null; setBusy(false); sessionUI(session); return;
      }
      task.steps.forEach(showStep);
      if (activeRunBody && activeRunBody.textContent !== task.assistantText) activeRunBody.innerHTML = formatMessage(task.assistantText || '');
    } catch {}
  }, 1800);
}

async function submit() {
  if (current && busySessions.has(current.id)) return;
  let text = $('#prompt').value.trim(); if (!text) return;
  if (!current) await newSession(false);
  if (!current) return;
  const sessionId = current.id;
  let model = $('#modelSelect').value;
  if (model === 'custom') {
    model = prompt('输入兼容 OpenAI API 的模型名称');
    if (!model?.trim()) return;
    model = model.trim();
  }
  busySessions.add(sessionId); setBusy(true);
  const selectedFiles = [...attachedFiles]; const uploadedFiles = [];
  try {
    for (const file of selectedFiles) {
      if (file.uploaded) { uploadedFiles.push(file.uploaded); continue; }
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
      const result = await api(`/sessions/${sessionId}/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: file.name, contentBase64: btoa(binary) }) });
      file.uploaded = result; uploadedFiles.push(result);
    }
  } catch (error) { setBusy(false); toast(error.message); return; }
  $('#prompt').value = ''; $('#prompt').style.height = '';
  addMessage('user', text, uploadedFiles); activeRunBody = addMessage('assistant', '');
  let assistantText = '';
  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text, model, attachments: uploadedFiles }) });
    if (!response.ok) throw new Error((await response.json()).error || '发送失败');
    attachedFiles = []; $('#attachButton').innerHTML = '<span>＋</span> 添加上下文';
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const event = (block.match(/^event: (.+)$/m) || [])[1], data = (block.match(/^data: (.+)$/m) || [])[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data);
        if (event === 'task') { addActivity('Orbit 正在规划任务'); watchTask(sessionId, payload.id); }
        else if (event === 'delta') { assistantText += payload.text; if (current?.id === sessionId && activeRunBody) activeRunBody.innerHTML = formatMessage(assistantText); }
        else if (event === 'step') { if (current?.id === sessionId) showStep(payload); }
        else if (event === 'error' || event === 'cancelled') {
          assistantText = payload.message; if (current?.id === sessionId && activeRunBody) activeRunBody.innerHTML = formatMessage(assistantText);
          if (event === 'error') toast(payload.message);
        }
      }
    }
  } catch (error) {
    if (current?.id === sessionId && activeRunBody) { activeRunBody.textContent = error.message; activeRunBody.style.color = '#a64242'; }
    toast(error.message);
  } finally {
    const session = await api(`/sessions/${sessionId}`).catch(() => null);
    if (!session?.activeTask) busySessions.delete(sessionId);
    if (session && current?.id === sessionId) { sessionUI(session); }
    refreshSessions(); refreshFiles(sessionId);
  }
}

async function cancelTask() {
  if (!current) return;
  try { await api(`/sessions/${current.id}/cancel`, { method: 'POST' }); toast('正在停止当前任务…'); }
  catch (error) { toast(error.message); }
}
async function startDesktop() {
  const button = $('#startDesktop'); if (button) { button.disabled = true; button.textContent = '正在启动…'; }
  try {
    const result = await api(`/sessions/${current.id}/desktop`, { method: 'POST' });
    $('#desktopFrame').innerHTML = `<iframe title="Orbit 云端 Ubuntu 桌面" src="${escapeHtml(result.url)}" allow="clipboard-read; clipboard-write; fullscreen"></iframe>`;
    $('#openDesktop').onclick = () => window.open(result.url, '_blank', 'noopener');
    $('#envSub').textContent = '独立 Ubuntu 桌面已运行';
  } catch (error) { toast(error.message); if (button) { button.disabled = false; button.textContent = '重试启动'; } }
}
function selectTab(name) {
  $$('.inspector-tab').forEach(tab => tab.classList.toggle('selected', tab.dataset.tab === name));
  $('#taskPane').classList.toggle('hidden', name !== 'task'); $('#desktopPane').classList.toggle('hidden', name !== 'desktop');
  if (innerWidth <= 830) $('#inspector').classList.add('open');
}

$('#composerForm').addEventListener('submit', event => { event.preventDefault(); submit(); });
$('#prompt').addEventListener('input', event => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`; });
$('#prompt').addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); submit(); } });
$('#newChat').onclick = () => newSession(); $('#stopTaskButton').onclick = cancelTask;
$('#menuToggle').onclick = () => $('#sidebar').classList.add('open'); $('#sidebarClose').onclick = () => $('#sidebar').classList.remove('open');
$('#inspectorClose').onclick = () => $('#inspector').classList.remove('open');
$$('.inspector-tab').forEach(tab => tab.onclick = () => selectTab(tab.dataset.tab));
$('#desktopNav').onclick = event => { event.preventDefault(); selectTab('desktop'); };
$('#openDesktop').onclick = () => toast('先启动云端桌面');
$$('.suggestion').forEach(button => button.onclick = () => { $('#prompt').value = button.dataset.prompt; $('#prompt').focus(); $('#prompt').dispatchEvent(new Event('input')); });
$('#attachButton').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = async event => {
  const files = [...event.target.files]; if (!files.length) return;
  try {
    const supported = /\.(txt|md|csv|json|html|css|js|py|pdf|docx|xlsx|pptx)$/i;
    if (files.some(file => file.size > 15 * 1024 * 1024)) throw new Error('单个附件不能超过 15 MB');
    if (files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) throw new Error('一次最多附加 25 MB 文件');
    if (files.some(file => !supported.test(file.name))) throw new Error('支持文本、PDF、Word、Excel 和 PowerPoint 文件');
    attachedFiles = files; $('#attachButton').innerHTML = `<span>✓</span> 已附加 ${files.length} 个文件`; toast('文件将上传到当前对话的云端电脑');
  } catch (error) { toast(error.message); }
  event.target.value = '';
};
$('#shortcutHint').onclick = () => toast('按 ⌘ ↵（Windows/Linux：Ctrl ↵）发送任务');
$('.voice-button')?.addEventListener('click', () => {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return toast('当前浏览器暂不支持语音输入');
  const recognition = new Recognition(); recognition.lang = 'zh-CN'; recognition.interimResults = false;
  recognition.onresult = event => { $('#prompt').value += event.results[0][0].transcript; $('#prompt').dispatchEvent(new Event('input')); };
  recognition.onerror = () => toast('语音输入不可用，请检查麦克风权限'); recognition.start();
});
$$('[aria-label="分享任务"]').forEach(button => button.onclick = async () => {
  if (!current) return;
  const shareUrl = new URL(`?session=${encodeURIComponent(current.id)}`, location.href).toString();
  try { await navigator.clipboard.writeText(shareUrl); toast('当前对话链接已复制'); }
  catch { toast('无法复制链接，请手动复制地址栏链接'); }
});
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newSession(); } });
init();
