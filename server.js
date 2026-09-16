const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.claude');
const PROJECTS = path.join(ROOT, 'projects');
const SESSIONS = path.join(ROOT, 'sessions');
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4567);

const cache = new Map();
const TAG = /<cross-session-message\s+([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/;
const MARKERS = ['SendMessage', 'cross-session-message', '"agent-name"', '"custom-title"'];

function parseAttrs(s) {
  const o = {};
  s.replace(/([\w-]+)=\\?"([^"\\]*)\\?"/g, (_, k, v) => { o[k] = v; return ''; });
  return o;
}

function stripRef(to) {
  return String(to || '').replace(/\s*\[[0-9a-f]{4,}\]\s*$/i, '').trim();
}

function listTranscripts() {
  const out = [];
  if (!fs.existsSync(PROJECTS)) return out;
  for (const proj of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, proj);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function pushIncoming(data, text, ts) {
  const m = TAG.exec(text);
  if (!m) return;
  const a = parseAttrs(m[1]);
  data.incoming.push({
    ts,
    fromName: a['from-name'] || '',
    fromAddr: a.from || '',
    fromMode: a['from-mode'] || '',
    body: m[2],
  });
}

function parseFile(file) {
  const st = fs.statSync(file);
  const cached = cache.get(file);
  if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) return cached.data;

  const data = {
    sessionId: path.basename(file, '.jsonl'),
    project: path.basename(path.dirname(file)),
    agentName: null,
    customTitle: null,
    cwd: null,
    firstTs: null,
    lastTs: null,
    outgoing: [],
    incoming: [],
    results: new Map(),
  };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('SendMessage') && !text.includes('cross-session-message')) {
    cache.set(file, { size: st.size, mtime: st.mtimeMs, data });
    return data;
  }
  const pendingIds = new Set();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let interesting = i < 5 || MARKERS.some(k => line.includes(k));
    if (!interesting) for (const id of pendingIds) if (line.includes(id)) { interesting = true; break; }
    if (!interesting) {
      if (line.includes('"timestamp"')) {
        const m = /"timestamp":"([^"]+)"/.exec(line);
        if (m) { if (!data.firstTs) data.firstTs = m[1]; data.lastTs = m[1]; }
      }
      continue;
    }
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp) { if (!data.firstTs) data.firstTs = o.timestamp; data.lastTs = o.timestamp; }
    if (o.cwd && !data.cwd) data.cwd = o.cwd;
    const t = o.type;
    if (t === 'agent-name' && o.agentName) data.agentName = o.agentName;
    else if (t === 'custom-title' && o.customTitle) data.customTitle = o.customTitle;
    else if (t === 'assistant') {
      const content = o.message && o.message.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b && b.type === 'tool_use' && b.name === 'SendMessage' && b.input) {
          pendingIds.add(b.id);
          data.outgoing.push({
            id: b.id,
            ts: o.timestamp,
            to: String(b.input.to || b.input.recipient || ''),
            summary: b.input.summary || '',
            body: String(b.input.message || b.input.content || ''),
          });
        }
      }
    } else if (t === 'user') {
      const content = o.message && o.message.content;
      if (typeof content === 'string') {
        if (content.includes('<cross-session-message')) pushIncoming(data, content, o.timestamp);
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'tool_result' && pendingIds.has(b.tool_use_id)) {
            const txt = Array.isArray(b.content) ? b.content.map(x => x.text || '').join('\n') : String(b.content || '');
            data.results.set(b.tool_use_id, { txt, isError: !!b.is_error });
            pendingIds.delete(b.tool_use_id);
          } else if (b.type === 'text' && b.text && b.text.includes('<cross-session-message')) {
            pushIncoming(data, b.text, o.timestamp);
          }
        }
      }
    }
  }
  cache.set(file, { size: st.size, mtime: st.mtimeMs, data });
  return data;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function liveSessions() {
  const out = [];
  if (!fs.existsSync(SESSIONS)) return out;
  for (const f of fs.readdirSync(SESSIONS)) {
    if (!f.endsWith('.json')) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8'));
      if (!o.pid || !isAlive(o.pid)) continue;
      if (o.entrypoint === 'sdk-cli' || o.kind !== 'interactive') continue;
      out.push({
        pid: o.pid,
        sessionId: o.sessionId,
        name: o.name || '',
        status: o.status || '',
        cwd: o.cwd || '',
        startedAt: o.startedAt ? new Date(o.startedAt).toISOString() : null,
        updatedAt: o.updatedAt ? new Date(o.updatedAt).toISOString() : null,
        socket: o.messagingSocketPath || '',
      });
    } catch {}
  }
  return out;
}

function statusFromResult(r) {
  if (!r) return { status: 'sent', note: '' };
  let status = r.isError ? 'failed' : 'sent';
  let note = r.txt;
  try {
    const j = JSON.parse(r.txt);
    if (j.success === false) status = 'failed';
    note = j.message || j.error || r.txt;
  } catch {
    if (/not found|refused|failed|error|no such|unknown/i.test(r.txt)) status = 'failed';
  }
  return { status, note: String(note).slice(0, 600) };
}

function buildState() {
  const sessions = new Map();
  const outgoing = [];
  const incoming = [];
  const live = liveSessions();
  const liveById = new Map(live.map(s => [s.sessionId, s]));
  for (const f of listTranscripts()) {
    let d;
    try { d = parseFile(f); } catch { continue; }
    if (!d.outgoing.length && !d.incoming.length) continue;
    const lv = liveById.get(d.sessionId);
    const name = d.agentName || d.customTitle || (lv && lv.name) || d.sessionId.slice(0, 8);
    sessions.set(d.sessionId, {
      sessionId: d.sessionId, name, cwd: d.cwd, project: d.project,
      firstTs: d.firstTs, lastTs: d.lastTs, sent: d.outgoing.length, received: d.incoming.length,
    });
    for (const m of d.outgoing) {
      const { status, note } = statusFromResult(d.results.get(m.id));
      outgoing.push({ ...m, fromSessionId: d.sessionId, fromName: name, status, note });
    }
    for (const m of d.incoming) incoming.push({ ...m, toSessionId: d.sessionId, toName: name });
  }

  const addrName = new Map();
  for (const i of incoming) if (i.fromAddr && i.fromName) addrName.set(i.fromAddr, i.fromName);
  for (const s of live) if (s.socket && s.name) addrName.set('uds:' + s.socket, s.name);
  const resolveName = raw => {
    const n = stripRef(raw);
    if (addrName.has(n)) return addrName.get(n);
    const m = /^uds:.*\/(\d+)\.sock$/.exec(n);
    return m ? `pid ${m[1]}` : n;
  };
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const byBody = new Map();
  for (const o of outgoing) {
    const k = norm(o.body);
    if (!byBody.has(k)) byBody.set(k, []);
    byBody.get(k).push(o);
  }
  const messages = outgoing.map(o => ({
    id: o.id, ts: o.ts,
    from: { name: o.fromName, sessionId: o.fromSessionId },
    to: { name: resolveName(o.to), raw: o.to, sessionId: null },
    summary: o.summary, body: o.body, status: o.status, note: o.note, deliveredAt: null,
  }));
  const msgById = new Map(messages.map(m => [m.id, m]));
  const matched = new Set();
  incoming.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  for (const i of incoming) {
    const cands = (byBody.get(norm(i.body)) || []).filter(o => !matched.has(o.id));
    let best = null, bestScore = -Infinity;
    for (const o of cands) {
      const dt = Math.abs(new Date(o.ts) - new Date(i.ts));
      if (dt > 6 * 3600e3) continue;
      let score = -dt / 1000;
      if (o.fromName === i.fromName) score += 100000;
      if (resolveName(o.to) === i.toName) score += 100000;
      if (score > bestScore) { bestScore = score; best = o; }
    }
    if (best) {
      matched.add(best.id);
      const m = msgById.get(best.id);
      m.status = 'delivered';
      m.deliveredAt = i.ts;
      m.to.sessionId = i.toSessionId;
      if (i.toName) m.to.name = i.toName;
    } else {
      messages.push({
        id: 'in-' + i.toSessionId + '-' + i.ts, ts: i.ts,
        from: { name: i.fromName, sessionId: null, addr: i.fromAddr },
        to: { name: i.toName, raw: i.toName, sessionId: i.toSessionId },
        summary: '', body: i.body, status: 'delivered', note: '', deliveredAt: i.ts, inferred: true,
      });
    }
  }
  messages.sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const liveIds = new Set(live.map(s => s.sessionId));
  for (const s of live) {
    const t = sessions.get(s.sessionId);
    if (t) { t.live = s; if (s.name) t.name = s.name; }
    else sessions.set(s.sessionId, { sessionId: s.sessionId, name: s.name || s.sessionId.slice(0, 8), cwd: s.cwd, project: '', firstTs: s.startedAt, lastTs: s.updatedAt, sent: 0, received: 0, live: s });
  }
  for (const m of messages) {
    if (m.from.sessionId && liveIds.has(m.from.sessionId)) m.from.live = true;
    if (m.to.sessionId && liveIds.has(m.to.sessionId)) m.to.live = true;
  }
  return { generatedAt: new Date().toISOString(), sessions: [...sessions.values()], messages };
}

const clients = new Set();
let timer = null;
function notify() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    for (const res of clients) res.write('event: change\ndata: {}\n\n');
  }, 400);
}

function watchAll() {
  const opts = { persistent: true, recursive: true };
  for (const dir of [PROJECTS, SESSIONS]) {
    if (!fs.existsSync(dir)) continue;
    try { fs.watch(dir, opts, notify); } catch (e) { console.error('watch failed', dir, e.message); }
  }
  setInterval(notify, 15000);
}

function findTranscript(sessionId) {
  if (!/^[0-9a-f-]{20,}$/i.test(sessionId)) return null;
  for (const proj of fs.readdirSync(PROJECTS)) {
    const f = path.join(PROJECTS, proj, sessionId + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function peerName(raw) {
  const n = stripRef(raw);
  const m = /^uds:.*\/(\d+)\.sock$/.exec(n);
  if (!m) return n;
  for (const s of liveSessions()) if (String(s.pid) === m[1]) return s.name || n;
  return `pid ${m[1]}`;
}

function toolLabel(name, input) {
  input = input || {};
  const short = v => String(v || '').replace(os.homedir(), '~').slice(0, 120);
  switch (name) {
    case 'Bash': return input.description ? `執行指令：${short(input.description)}` : `執行指令：${short(input.command)}`;
    case 'Read': return `讀檔案：${short(input.file_path)}`;
    case 'Edit': case 'Write': case 'NotebookEdit': return `改檔案：${short(input.file_path)}`;
    case 'Grep': case 'Glob': return `搜尋：${short(input.pattern)}`;
    case 'Agent': return `派子任務：${short(input.description)}`;
    case 'SendMessage': return `傳訊息給 ${short(peerName(input.to))}：${short(input.summary || input.message)}`;
    case 'WebFetch': case 'WebSearch': return `查網路：${short(input.url || input.query)}`;
    case 'Skill': return `用技能：${short(input.skill)}`;
    case 'Artifact': return `發佈網頁：${short(input.file_path || input.action)}`;
    case 'AskUserQuestion': return '在問使用者問題';
    default: return `${name}：${short(JSON.stringify(input))}`;
  }
}

function activity(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return { error: 'not found' };
  const st = fs.statSync(file);
  const size = Math.min(st.size, 400000);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, st.size - size);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (st.size > size) lines.shift();
  const out = { sessionId, lastPrompt: null, lastIncoming: null, lastText: null, lastTool: null, runningTool: null, cwd: null, updatedAt: st.mtime.toISOString() };
  const pending = new Map();
  for (const line of lines) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.cwd) out.cwd = o.cwd;
    const t = o.type;
    if (t === 'assistant') {
      for (const b of (o.message && o.message.content) || []) {
        if (!b) continue;
        if (b.type === 'text' && b.text && b.text.trim()) out.lastText = { text: b.text.trim().slice(0, 600), ts: o.timestamp };
        if (b.type === 'tool_use') {
          const tool = { name: b.name, label: toolLabel(b.name, b.input), ts: o.timestamp };
          out.lastTool = tool;
          pending.set(b.id, tool);
        }
      }
    } else if (t === 'user') {
      const c = o.message && o.message.content;
      if (typeof c === 'string') {
        const m = TAG.exec(c);
        if (m) {
          const a = parseAttrs(m[1]);
          out.lastIncoming = { from: a['from-name'] || '', text: m[2].trim().slice(0, 600), ts: o.timestamp };
        } else if (!c.startsWith('[Cross-session') && !c.startsWith('<') && !c.startsWith('This session is being continued')) {
          out.lastPrompt = { text: c.trim().slice(0, 600), ts: o.timestamp };
        }
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (!b) continue;
          if (b.type === 'tool_result') pending.delete(b.tool_use_id);
          else if (b.type === 'text' && b.text && !b.text.startsWith('<') && !b.text.startsWith('[')) out.lastPrompt = { text: b.text.trim().slice(0, 600), ts: o.timestamp };
        }
      }
    }
  }
  const running = [...pending.values()];
  out.runningTool = running.length ? running[running.length - 1] : null;
  return out;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/state') {
    let body;
    try { body = JSON.stringify(buildState()); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(body);
  }
  if (url.pathname === '/api/activity') {
    let body;
    try { body = JSON.stringify(activity(url.searchParams.get('session') || '')); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(body);
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('event: hello\ndata: {}\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`session-communicate UI: http://127.0.0.1:${PORT}`);
  watchAll();
});
