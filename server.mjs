import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  const env = await fs.readFile(path.join(root, '.env'), 'utf8');
  for (const row of env.split(/\r?\n/)) {
    const m = row.match(/^([^#=\s]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = Number(process.env.PORT || 3000);
const DATA = path.join(root, '.data');
const DB = path.join(DATA, 'sessions.json');
await fs.mkdir(DATA, { recursive: true });
let sessions = {};
try { sessions = JSON.parse(await fs.readFile(DB, 'utf8')); } catch {}
let recoveredTask = false;
for (const session of Object.values(sessions)) {
  delete session.abortController;
  if (session.activeTask?.status === 'running') {
    recoveredTask = true;
    session.activeTask.status = 'interrupted';
    session.activeTask.finishedAt = Date.now();
    const savedTask = session.tasks?.find(task => task.id === session.activeTask.id);
    if (savedTask) Object.assign(savedTask, session.activeTask);
    session.messages.push({ role: 'assistant', content: session.activeTask.assistantText || 'Orbit 服务重启时任务中断了。你可以继续这个任务。' });
    session.activeTask = null;
  }
}
if (recoveredTask) await fs.writeFile(DB, JSON.stringify(sessions, null, 2));
let saveQueue = Promise.resolve();
function save() {
  const safeSessions = Object.fromEntries(Object.entries(sessions).map(([id, session]) => {
    const { abortController, ...safeSession } = session;
    return [id, safeSession];
  }));
  const snapshot = JSON.stringify(safeSessions, null, 2);
  saveQueue = saveQueue.catch(() => {}).then(() => fs.writeFile(DB, snapshot));
  return saveQueue;
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
function send(res, code, body, type = 'application/json') {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type.includes('json') ? JSON.stringify(body) : body);
}
async function readJson(req, maxBytes = 2_000_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxBytes) throw new Error('请求内容过大');
  }
  return body ? JSON.parse(body) : {};
}
function run(command, args, timeout = 120_000, signal, input = null) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ code: -1, out: '', err: '已停止' });
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(result);
    };
    const abort = () => child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (input) child.stdin.end(input); else child.stdin.end();
    child.stdout.on('data', chunk => { out += chunk; if (out.length > 40_000) out = out.slice(-40_000); });
    child.stderr.on('data', chunk => { err += chunk; if (err.length > 8_000) err = err.slice(-8_000); });
    child.on('close', code => finish({ code: signal?.aborted ? -1 : code, out, err: signal?.aborted ? '已停止' : err }));
    child.on('error', error => finish({ code: 127, out, err: error.message }));
  });
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const containerName = id => `orbit-${id.replaceAll('-', '').slice(0, 16)}`;

async function attachDesktopAddress(s) {
  const info = await run('docker', ['inspect', '-f', '{{.State.Running}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', s.containerId], 8_000);
  const [running, ip] = info.out.trim().split(/\s+/);
  if (info.code !== 0 || running !== 'true' || !ip) throw new Error('无法连接此对话的云端电脑');
  s.desktopHost = ip;
  s.desktopUrl = `/desktop/${s.id}/vnc.html?autoconnect=1&resize=remote&path=desktop/${s.id}/websockify`;
  await save();
}
async function ensureDesktop(s) {
  if (s.containerId) {
    const state = await run('docker', ['inspect', '-f', '{{.State.Running}}', s.containerId], 8_000);
    if (state.code === 0) {
      if (state.out.trim() !== 'true') {
        const started = await run('docker', ['start', s.containerId], 30_000);
        if (started.code !== 0) throw new Error(started.err || '云端电脑无法启动');
      }
      await attachDesktopAddress(s);
      return;
    }
    s.containerId = null; s.desktopHost = null; s.desktopUrl = '';
  }
  const name = containerName(s.id);
  const args = ['run', '-d', '--name', name, '--label', `orbit.session=${s.id}`, '--memory', process.env.CONTAINER_MEMORY || '4g', '--cpus', process.env.CONTAINER_CPUS || '2'];
  if (process.env.ORBIT_DOCKER_NETWORK) args.push('--network', process.env.ORBIT_DOCKER_NETWORK);
  args.push(process.env.CONTAINER_IMAGE || 'orbit-desktop:22.04');
  const created = await run('docker', args, 60_000);
  if (created.code !== 0) throw new Error(created.err || 'Docker 启动失败。请先构建 Orbit 桌面镜像。');
  s.containerId = created.out.trim();
  try { await attachDesktopAddress(s); }
  catch (error) { await run('docker', ['rm', '-f', s.containerId], 15_000); s.containerId = null; throw error; }
}

const toolDefs = [
  { type: 'function', function: { name: 'shell', description: 'Run a shell command in this conversation\'s isolated Ubuntu 22.04 desktop. User attachments are available under /home/orbit/Uploads. Use for files, scripts, package installs and task execution. Put deliverables in /home/orbit/Downloads.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Command to run' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List files under /home/orbit/Downloads in this session desktop', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file in /home/orbit/Downloads', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write a text file under /home/orbit/Downloads', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'open_browser', description: 'Open an http or https page in the graphical Chrome browser in the session desktop.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the public web for current information. Return source titles, URLs and snippets.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];

function allowedWorkspacePath(input = '/home/orbit/Downloads') {
  const target = path.posix.resolve('/home/orbit/Downloads', String(input));
  const allowed = ['/home/orbit/Downloads', '/home/orbit/Uploads'];
  if (!allowed.some(directory => target === directory || target.startsWith(`${directory}/`))) throw new Error('文件只能保存在此对话的文件夹中');
  return target;
}
function decodeHtml(value) {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}
async function webSearch(query, signal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { signal, headers: { 'user-agent': 'Mozilla/5.0 OrbitAgent/1.0' } });
  if (!response.ok) throw new Error(`网页搜索失败 (${response.status})`);
  const html = await response.text();
  return [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
    .slice(0, 6).map(match => ({ url: decodeHtml(match[1]), title: decodeHtml(match[2].replace(/<[^>]*>/g, '')), snippet: decodeHtml(match[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()) }));
}
async function executeTool(s, name, args, signal) {
  if (name === 'web_search') return webSearch(String(args.query || '').slice(0, 500), signal);
  await ensureDesktop(s);
  const cid = s.containerId;
  if (name === 'open_browser') {
    let url; try { url = new URL(String(args.url || '')); } catch { return { error: 'Invalid URL' }; }
    if (!['http:', 'https:'].includes(url.protocol)) return { error: 'Only http and https URLs are allowed' };
    const command = `mkdir -p /home/orbit/.config/orbit-chrome /home/orbit/.cache && DISPLAY=:0 google-chrome-stable --user-data-dir=/home/orbit/.config/orbit-chrome --new-window ${quote(url.toString())} >/home/orbit/.cache/orbit-chrome.log 2>&1 &`;
    const result = await run('docker', ['exec', cid, 'su', '-', 'orbit', '-c', command], 10_000, signal);
    return result.code === 0 ? { opened: url.toString() } : { error: result.err || 'Chrome could not be opened' };
  }
  if (name === 'shell') {
    const command = String(args.command || '').slice(0, 8_000);
    const result = await run('docker', ['exec', cid, 'bash', '-lc', command], 120_000, signal);
    if (result.code !== -1) await run('docker', ['exec', cid, 'chown', '-R', 'orbit:orbit', '/home/orbit/Downloads'], 30_000);
    return { exit_code: result.code, stdout: result.out.slice(-12_000), stderr: result.err.slice(-3_000) };
  }
  let target;
  try { target = allowedWorkspacePath(args.path); } catch (error) { return { error: error.message }; }
  if (name === 'list_files') {
    const result = await run('docker', ['exec', cid, 'bash', '-lc', `find ${quote(target)} -maxdepth 2 -type f -printf '%p\\t%s bytes\\n' 2>/dev/null | head -80`], 10_000, signal);
    return result.out || '(empty)';
  }
  if (name === 'read_file') {
    const result = await run('docker', ['exec', cid, 'bash', '-lc', `head -c 30000 ${quote(target)}`], 10_000, signal);
    return result.code === 0 ? result.out : { error: result.err || 'File not found' };
  }
  if (name === 'write_file') {
    const encoded = Buffer.from(String(args.content || '').slice(0, 200_000), 'utf8').toString('base64');
    const result = await run('docker', ['exec', cid, 'bash', '-lc', `mkdir -p "$(dirname ${quote(target)})" && echo ${quote(encoded)} | base64 -d > ${quote(target)}`], 10_000, signal);
    if (result.code === 0) await run('docker', ['exec', cid, 'chown', 'orbit:orbit', target], 10_000);
    return result.code === 0 ? { saved: target } : { error: result.err || 'Could not write file' };
  }
  return { error: 'Unknown tool' };
}

function emit(res, event, data) { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
async function finishTask(s, status, assistantText = '') {
  const task = s.activeTask;
  if (!task) return;
  task.status = status; task.finishedAt = Date.now(); task.assistantText = assistantText;
  const savedTask = s.tasks?.find(item => item.id === task.id);
  if (savedTask && savedTask !== task) Object.assign(savedTask, task);
  s.messages.push({ role: 'assistant', content: assistantText || (status === 'cancelled' ? '任务已停止。' : '任务未能完成。') });
  s.updatedAt = Date.now(); s.activeTask = null; s.abortController = null;
  await save();
}
async function runAgent(s, userText, model, res) {
  const key = process.env.MODEL_API_KEY;
  const base = (process.env.MODEL_BASE_URL || 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  const task = s.activeTask;
  const controller = s.abortController;
  const signal = controller.signal;
  let assistantText = '';
  const history = s.messages.slice(0, -1).slice(-20).map(message => ({ role: message.role, content: `${message.content}${message.attachments?.length ? `\n\nFiles available in the isolated session:\n${message.attachments.map(file => `- ${file.name}: ${file.path}`).join('\n')}` : ''}` }));
  history.unshift({ role: 'system', content: '你是 Orbit，一个面向真实工作任务的通用智能体。你运行在用户的独立 Ubuntu 22.04 桌面中。先理解目标，按需列步骤，用工具实际执行，检查产物，再用中文简洁汇报。不要声称执行了未执行的动作。重要操作（删除、对外发送、购买）先征求同意。命令应有边界且可验证。用户附件位于 /home/orbit/Uploads：读取 PDF 时用 pdftotext；读取 XLSX 时用 Python openpyxl；DOCX 和 PPTX 可用 Python zipfile 读取其 XML 文本。所有交付文件放在 /home/orbit/Downloads。' });
  const latestMessage = s.messages.at(-1);
  const fileContext = latestMessage?.attachments?.length ? `\n\nThe user attached these files in this isolated session:\n${latestMessage.attachments.map(file => `- ${file.name}: ${file.path}`).join('\n')}` : '';
  history.push({ role: 'user', content: `${userText}${fileContext}` });
  emit(res, 'task', { id: task.id, title: task.title, status: 'running' });
  const persistFailure = async message => {
    assistantText = assistantText ? `${assistantText}\n\n${message}` : message;
    await finishTask(s, signal.aborted ? 'cancelled' : 'failed', assistantText);
    emit(res, signal.aborted ? 'cancelled' : 'error', { message: assistantText, taskId: task.id });
  };
  if (!key) return persistFailure('未配置模型 API Key。请在服务端 .env 中设置 MODEL_API_KEY。');
  try {
    for (let turn = 0; turn < 8; turn++) {
      if (signal.aborted) return persistFailure('任务已停止。');
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST', signal,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: history, tools: toolDefs, tool_choice: 'auto', temperature: 0.3 }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return persistFailure(payload.error?.message || `模型请求失败 (${response.status})`);
      const message = payload.choices?.[0]?.message;
      if (!message) return persistFailure('模型未返回有效结果。');
      history.push(message);
      if (message.content) {
        assistantText += message.content;
        task.assistantText = assistantText;
        await save();
        emit(res, 'delta', { text: message.content });
      }
      if (!message.tool_calls?.length) {
        await finishTask(s, 'completed', assistantText || '任务已完成。');
        emit(res, 'done', { taskId: task.id });
        return;
      }
      for (const call of message.tool_calls) {
        if (signal.aborted) return persistFailure('任务已停止。');
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
        const title = call.function.name === 'shell' ? String(args.command || '执行命令').slice(0, 100) : call.function.name === 'web_search' ? `搜索：${args.query}` : call.function.name;
        const step = { id: call.id, title, tool: call.function.name, status: 'running', startedAt: Date.now() };
        task.steps.push(step); await save(); emit(res, 'step', step);
        let result;
        try { result = await executeTool(s, call.function.name, args, signal); }
        catch (error) { result = { error: error.message }; }
        if (signal.aborted) return persistFailure('任务已停止。');
        step.status = 'complete'; step.finishedAt = Date.now(); step.result = (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 4_000);
        await save();
        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 18_000) });
        emit(res, 'step', { ...step, result: step.result });
      }
    }
    return persistFailure('本轮执行达到步骤上限。你可以继续告诉 Orbit 下一步。');
  } catch (error) {
    return persistFailure(signal.aborted ? '任务已停止。' : `执行失败：${error.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (process.env.ORBIT_PASSWORD) {
      const auth = req.headers.authorization || '';
      let provided = '';
      try { if (auth.startsWith('Basic ')) provided = Buffer.from(auth.slice(6), 'base64').toString('utf8'); } catch {}
      const expected = `${process.env.ORBIT_USERNAME || 'orbit'}:${process.env.ORBIT_PASSWORD}`;
      const got = Buffer.from(provided), want = Buffer.from(expected);
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Orbit", charset="UTF-8"', 'cache-control': 'no-store' }); return res.end('需要登录 Orbit');
      }
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': 'null', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' }); return res.end(); }
    if (url.pathname === '/api/models' && req.method === 'GET') {
      const defaultModel = process.env.DEFAULT_MODEL || 'qwen3.7-plus';
      const choices = [{ id: defaultModel, label: `百炼 Token Plan · ${defaultModel}` }, { id: 'qwen3.7-max', label: 'Qwen 3.7 Max' }, { id: 'qwen3.7-plus', label: 'Qwen 3.7 Plus' }, { id: 'qwen3.6-flash', label: 'Qwen 3.6 Flash' }, { id: 'glm-5.3', label: 'GLM 5.3' }, { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }, { id: 'deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash' }, { id: 'auto', label: '自动选择模型' }, { id: 'custom', label: '自定义模型…' }];
      return send(res, 200, { models: choices.filter((model, index) => index === 0 || model.id !== defaultModel), configured: Boolean(process.env.MODEL_API_KEY) });
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') return send(res, 200, Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, title, updatedAt, messages, activeTask }) => ({ id, title, updatedAt, messageCount: messages.length, activeTask: activeTask && { id: activeTask.id, title: activeTask.title, status: activeTask.status } })));
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      const session = { id: randomUUID(), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [], tasks: [], uploadedFiles: [], containerId: null, desktopHost: null, desktopUrl: '', activeTask: null };
      sessions[session.id] = session; await save();
      let desktopState = 'available'; try { await ensureDesktop(session); } catch (error) { desktopState = error.message; }
      return send(res, 201, { ...session, desktopState, abortController: undefined });
    }
    const match = url.pathname.match(/^\/api\/sessions\/([\w-]+)(?:\/(.*))?$/);
    if (match) {
      const session = sessions[match[1]];
      if (!session) return send(res, 404, { error: 'Session not found' });
      const action = match[2] || '';
      if (!action && req.method === 'GET') {
        const { abortController, ...safeSession } = session;
        return send(res, 200, safeSession);
      }
      if (action === 'messages' && req.method === 'POST') {
        if (session.activeTask?.status === 'running') return send(res, 409, { error: '此任务仍在运行，请先停止或等待完成。' });
        const body = await readJson(req);
        const userText = String(body.message || '').trim().slice(0, 40_000);
        if (!userText) return send(res, 400, { error: '请输入任务内容' });
        if (!session.messages.length) session.title = userText.slice(0, 42);
        const requestedPaths = Array.isArray(body.attachments) ? new Set(body.attachments.map(file => String(file.path || ''))) : new Set();
        const attachments = (session.uploadedFiles || []).filter(file => requestedPaths.has(file.path));
        session.messages.push({ role: 'user', content: userText, attachments });
        session.updatedAt = Date.now();
        session.activeTask = { id: randomUUID(), title: userText.slice(0, 100), status: 'running', startedAt: Date.now(), model: String(body.model || process.env.DEFAULT_MODEL || 'qwen3.7-plus'), assistantText: '', steps: [] };
        session.tasks ||= []; session.tasks.push(session.activeTask); session.tasks = session.tasks.slice(-50);
        session.abortController = new AbortController();
        await save();
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.on('close', () => { if (!res.writableEnded && session.activeTask?.status === 'running') session.abortController?.abort(); });
        await ensureDesktop(session).catch(() => {});
        await runAgent(session, userText, session.activeTask.model, res);
        res.end(); return;
      }
      if (action === 'cancel' && req.method === 'POST') {
        if (session.activeTask?.status !== 'running') return send(res, 409, { error: '当前没有正在运行的任务' });
        session.abortController?.abort(); return send(res, 200, { ok: true });
      }
      if (action === 'upload' && req.method === 'POST') {
        const body = await readJson(req, 22 * 1024 * 1024);
        const originalName = String(body.name || '').replaceAll('\\', '/').split('/').at(-1).slice(0, 120);
        const extension = path.extname(originalName).toLowerCase();
        const supported = new Set(['.txt', '.md', '.csv', '.json', '.html', '.css', '.js', '.py', '.pdf', '.docx', '.xlsx', '.pptx']);
        const encoded = String(body.contentBase64 || '');
        if (!supported.has(extension)) return send(res, 415, { error: '支持文本、PDF、Word、Excel 和 PowerPoint 文件' });
        if (!encoded || encoded.length > 21 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return send(res, 413, { error: '附件内容无效或超过 15 MB' });
        const content = Buffer.from(encoded, 'base64');
        if (content.length > 15 * 1024 * 1024) return send(res, 413, { error: '单个附件不能超过 15 MB' });
        const safeName = originalName.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '_').slice(0, 100);
        if (!safeName || path.extname(safeName).toLowerCase() !== extension) return send(res, 400, { error: '文件名无效' });
        try {
          await ensureDesktop(session);
          const filePath = `/home/orbit/Uploads/${randomUUID()}-${safeName}`;
          const result = await run('docker', ['exec', '-i', session.containerId, 'bash', '-lc', `mkdir -p /home/orbit/Uploads && cat > ${quote(filePath)}`], 30_000, null, content);
          if (result.code !== 0) return send(res, 500, { error: result.err || '无法写入云端附件' });
          await run('docker', ['exec', session.containerId, 'chown', 'orbit:orbit', filePath], 10_000);
          const file = { id: randomUUID(), name: originalName, path: filePath, size: content.length, uploadedAt: Date.now() };
          session.uploadedFiles ||= []; session.uploadedFiles.push(file); await save();
          return send(res, 201, file);
        } catch (error) { return send(res, 503, { error: error.message }); }
      }
      if (action === 'desktop' && req.method === 'POST') {
        try { await ensureDesktop(session); return send(res, 200, { url: session.desktopUrl }); }
        catch (error) { return send(res, 503, { error: error.message }); }
      }
      if (action === 'files' && req.method === 'GET') {
        try {
          await ensureDesktop(session);
          const result = await run('docker', ['exec', session.containerId, 'bash', '-lc', 'find /home/orbit/Downloads -maxdepth 2 -type f -printf "%p\\t%s\\n" | head -100'], 10_000);
          const files = result.out.trim().split('\n').filter(Boolean).map(row => { const [file, size] = row.split('\t'); return { path: file, name: path.basename(file), size: Number(size) || 0 }; });
          return send(res, 200, files);
        } catch (error) { return send(res, 503, { error: error.message }); }
      }
      if (action === 'download' && req.method === 'GET') {
        let requested;
        try { requested = allowedWorkspacePath(url.searchParams.get('path')); }
        catch (error) { return send(res, 403, { error: error.message }); }
        try {
          await ensureDesktop(session);
          const temp = path.join(os.tmpdir(), `orbit-${randomUUID()}`);
          const copied = await run('docker', ['cp', `${session.containerId}:${requested}`, temp], 30_000);
          if (copied.code !== 0) return send(res, 404, { error: '找不到文件' });
          const data = await fs.readFile(temp); await fs.rm(temp, { force: true });
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(requested))}`, 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          return res.end(data);
        } catch (error) { return send(res, 500, { error: error.message }); }
      }
      if (action === 'stop' && req.method === 'POST') {
        if (session.activeTask?.status === 'running') session.abortController?.abort();
        if (session.containerId) await run('docker', ['stop', session.containerId], 30_000);
        return send(res, 200, { ok: true });
      }
      if (!action && req.method === 'DELETE') {
        session.abortController?.abort();
        if (session.containerId) await run('docker', ['rm', '-f', session.containerId], 30_000);
        delete sessions[session.id]; await save(); return send(res, 200, { ok: true });
      }
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    const desktop = url.pathname.match(/^\/desktop\/([\w-]+)\/(.*)$/);
    if (desktop) {
      const session = sessions[desktop[1]];
      if (!session?.desktopHost) return send(res, 404, 'Desktop not available', 'text/plain');
      const upstream = http.request({ host: session.desktopHost, port: 6080, path: `/${desktop[2]}${url.search}`, method: req.method, headers: { ...req.headers, host: `${session.desktopHost}:6080` } }, response => { res.writeHead(response.statusCode || 502, response.headers); response.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) send(res, 502, 'Desktop proxy unavailable', 'text/plain'); }); req.pipe(upstream); return;
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    const full = path.resolve(root, 'public', file);
    if (!full.startsWith(`${path.join(root, 'public')}${path.sep}`)) return send(res, 403, 'Forbidden', 'text/plain');
    try { const data = await fs.readFile(full); return send(res, 200, data, mime[path.extname(full)] || 'application/octet-stream'); }
    catch { return send(res, 404, 'Not found', 'text/plain'); }
  } catch (error) {
    if (!res.headersSent) send(res, error.message === '请求内容过大' ? 413 : error instanceof SyntaxError ? 400 : 500, { error: error.message }); else res.end();
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/desktop\/([\w-]+)\/(.*)$/);
  const session = match && sessions[match[1]];
  if (!session?.desktopHost) return socket.destroy();
  const upstream = http.request({ host: session.desktopHost, port: 6080, path: `/${match[2]}${url.search}`, method: 'GET', headers: { ...req.headers, host: `${session.desktopHost}:6080` } });
  upstream.on('upgrade', (response, remote, remoteHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
    if (remoteHead.length) socket.write(remoteHead); if (head.length) remote.write(head); remote.pipe(socket); socket.pipe(remote);
  });
  upstream.on('error', () => socket.destroy()); upstream.end();
});

server.listen(PORT, '0.0.0.0', () => console.log(`Orbit ready on :${PORT}`));
