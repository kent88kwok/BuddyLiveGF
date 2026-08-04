// BuddyLiveGF Windows — launcher + CDP injector（安全加固 / 性能优化版）
//
// 参考上游 Codex-QQ-Skin（同作者的另一款皮肤工具，含真实开源注入实现）后做的安全与健壮性加固：
//  1) 严格校验 CDP WebSocket URL：仅允许回环地址（127.0.0.1 / localhost / [::1]）、
//     必须为我们指定的调试端口、禁止任何凭据（user/pass/search/hash）、路径必须为
//     /devtools/page/<id>。杜绝 SSRF / DNS 重绑定式外联。
//  2) 健壮的 CdpSession：open 超时、逐命令超时、消息解析失败即关闭、clean close。
//     原版无超时，CDP 调用卡死会拖垮整个进程。
//  3) 仅向合法的 WorkBuddy 工作区 page 注入；排除 devtools / 扩展宿主 / about:blank / webview。
//  4) 幂等：端口已开则「热附连」（不杀进程、不重启）；仅在端口未开时带调试端口重启一次。
//  5) 注入后做 DOM 校验确认皮肤已常驻；可选 --remove 卸载、--watch 常驻监听新窗口。
//
// 用法：
//   双击 BuddyLiveGF.exe        -> 一键注入（3 秒后自动退出）
//   node launcher.js            -> 注入并进入交互（corner/immersive/theme/exit）
//   node launcher.js --remove   -> 卸载皮肤
//   node launcher.js --watch    -> 常驻：自动注入日后新开的工作区窗口
//   node launcher.js --port 9223 -> 指定调试端口

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const DEBUG_PORTS = [9222, 9223, 9224];
const APP_EXE = process.env.WORKBUDDY_EXE || 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe';
const BOOTSTRAP = path.join(__dirname, 'inject', 'bootstrap.js');

// ---------- 严格 CDP WebSocket URL 校验（防 SSRF / DNS 重绑定）----------
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const CDP_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

function validatedDebuggerUrl(target, port) {
  const raw = target && target.webSocketDebuggerUrl;
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('缺少 webSocketDebuggerUrl');
  const url = new URL(raw);
  const pathIsValid = /^\/devtools\/page\/[A-Za-z0-9._-]{1,200}$/.test(url.pathname);
  if (
    url.protocol !== 'ws:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    Number(url.port) !== port ||
    url.username || url.password || url.search || url.hash ||
    !pathIsValid
  ) {
    throw new Error('拒绝连接到不符合白名单形状的 CDP WebSocket URL（仅允许本机回环、指定端口、无凭据）');
  }
  return url.href;
}

// 仅接受合法的 WorkBuddy 工作区页面
function isValidWorkbenchTarget(item, port) {
  if (item == null || item.type !== 'page' || typeof item.id !== 'string' || !CDP_ID_PATTERN.test(item.id)) return false;
  if (!item.webSocketDebuggerUrl) return false;
  try { validatedDebuggerUrl(item, port); } catch { return false; }
  const u = (item.url || '').toLowerCase();
  if (!u || u === 'about:blank') return false;
  if (/devtools|chrome-devtools|extension|electron\.js|webview/.test(u)) return false;
  return true;
}

// ---------- 健壮 CDP 会话 ----------
class CdpSession {
  constructor(target, port) {
    this.target = target;
    this.port = port;
    this.ws = new WebSocket(validatedDebuggerUrl(target, port));
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }
  open(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { this.ws.close(); } catch {} reject(new Error('CDP WebSocket 连接超时')); }, timeoutMs);
      const onOpen = () => { clearTimeout(timer); resolve(); };
      const onErr = () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')); };
      this.ws.addEventListener('open', onOpen, { once: true });
      this.ws.addEventListener('error', onErr, { once: true });
      this.ws.addEventListener('message', (e) => this.onMessage(e));
      this.ws.addEventListener('close', () => {
        this.closed = true;
        for (const w of this.pending.values()) { clearTimeout(w.timeout); w.reject(new Error('CDP 连接已关闭')); }
        this.pending.clear();
      });
    });
  }
  onMessage(event) {
    let msg;
    try { msg = JSON.parse(String(event.data)); } catch { this.close(); return; }
    if (!msg || typeof msg !== 'object') { this.close(); return; }
    if (msg.id) {
      const w = this.pending.get(msg.id);
      if (!w) return;
      clearTimeout(w.timeout);
      this.pending.delete(msg.id);
      if (msg.error) w.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else w.resolve(msg.result);
    }
  }
  send(method, params = {}, timeoutMs = 10000) {
    if (this.closed) return Promise.reject(new Error('CDP 会话已关闭'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 命令超时: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (err) { clearTimeout(timeout); this.pending.delete(id); reject(err); }
    });
  }
  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue, userGesture: false });
    if (res && res.exceptionDetails) {
      const detail = (res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text;
      throw new Error(`渲染进程执行失败: ${detail}`);
    }
    return res && res.result ? res.result.value : undefined;
  }
  close() {
    for (const w of this.pending.values()) { clearTimeout(w.timeout); w.reject(new Error('CDP 会话已关闭')); }
    this.pending.clear();
    if (!this.closed) { try { this.ws.close(); } catch {} }
    this.closed = true;
  }
}

// ---------- 工具 ----------
function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('HTTP 超时')));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpReachable(port) {
  try { return await httpGetJson(`http://127.0.0.1:${port}/json/version`); } catch { return null; }
}
async function listAppTargets(port) {
  const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`, 2000);
  if (!Array.isArray(targets)) throw new Error('/json/list 返回非数组');
  return targets.filter((t) => isValidWorkbenchTarget(t, port));
}
async function waitForCDP(port, tries = 60) {
  for (let i = 0; i < tries; i++) { const v = await cdpReachable(port); if (v) return v; await sleep(500); }
  throw new Error(`WorkBuddy 调试端口 ${port} 在超时内未就绪`);
}

// ---------- 状态文件（%APPDATA%/BuddyLiveGF/state.json）----------
function stateRoot() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'BuddyLiveGF');
}
function writeState(port, pid) {
  try {
    const dir = stateRoot();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      port, pid, host: '127.0.0.1', injectedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
  } catch {}
}

// ---------- 注入 / 卸载 / 校验 ----------
async function applySkin(session, bootstrapSrc) {
  // 当前文档立即生效 + 之后导航自动生效（保持原版热切换能力）
  await session.evaluate(bootstrapSrc);
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: bootstrapSrc });
}
async function removeSkin(session) {
  await session.evaluate(`(() => { try { window.__buddylive && window.__buddylive.remove && window.__buddylive.remove(); } catch (e) {} return true; })()`);
}
async function verifySkin(session) {
  return session.evaluate(`(() => !!document.getElementById('buddylive-gf'))()`);
}

async function attachAndRun(port, bootstrapSrc, mode) {
  const targets = await listAppTargets(port);
  if (!targets.length) throw new Error('未发现可注入的 WorkBuddy 工作区页面');
  let ok = 0;
  for (const t of targets) {
    const session = new CdpSession(t, port);
    await session.open();
    try {
      await session.send('Runtime.enable');
      await session.send('Page.enable');
      if (mode === 'remove') {
        await removeSkin(session);
        console.log('  已卸载 ->', t.url || t.title || '(untitled)');
      } else {
        await applySkin(session, bootstrapSrc);
        const verified = await verifySkin(session);
        console.log('  已注入 ->', t.url || t.title || '(untitled)', verified ? '(已校验 OK)' : '(校验未通过)');
        if (verified) ok++;
      }
    } finally {
      session.close();
    }
  }
  return ok;
}

// 对单一 page 执行布局/主题指令（交互模式用）
async function eachTarget(port, fn) {
  const targets = await listAppTargets(port);
  for (const t of targets) {
    const session = new CdpSession(t, port);
    await session.open();
    try { await session.send('Runtime.enable'); await fn(session); }
    finally { session.close(); }
  }
}

async function findOpenPort(ports) {
  for (const p of ports) { const v = await cdpReachable(p); if (v) return { port: p, info: v }; }
  return null;
}

// ---------- 主流程 ----------
async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--remove') ? 'remove' : 'inject';
  const watch = args.includes('--watch');
  let ports = DEBUG_PORTS.slice();
  const pIdx = args.indexOf('--port');
  if (pIdx !== -1 && args[pIdx + 1]) {
    const p = Number(args[pIdx + 1]);
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) ports = [p];
  }

  const bootstrapSrc = fs.readFileSync(BOOTSTRAP, 'utf8');

  // 1) 找出已开放的端口（热附连）或重启一次以开启端口
  let chosen = await findOpenPort(ports);
  if (!chosen) {
    try { execSync('taskkill /IM WorkBuddy.exe /F', { stdio: 'ignore' }); } catch {}
    await sleep(1000);
    const port = ports[0];
    spawn(APP_EXE, [
      `--remote-debugging-port=${port}`,
      `--remote-debugging-address=127.0.0.1`,
    ], { stdio: 'ignore' });
    console.log(`WorkBuddy 已带调试端口 ${port} 重启`);
    chosen = { port, info: await waitForCDP(port) };
  } else {
    console.log(`检测到已开启的调试端口 ${chosen.port}，热附连（不重启）`);
  }
  console.log('CDP:', chosen.info.Browser, chosen.info.ProtocolVersion);

  // 2) 注入 / 卸载
  const ok = await attachAndRun(chosen.port, bootstrapSrc, mode);
  if (mode === 'inject') {
    writeState(chosen.port, process.pid);
    console.log(`\nBuddyLiveGF (Windows) 完成：已为 ${ok} 个工作区窗口注入皮肤。`);
  } else {
    console.log('\nBuddyLiveGF (Windows) 已完成皮肤卸载。');
  }

  // 3) 双击（无 TTY）→ 注入后短暂提示并退出；终端 → 进入交互 / 常驻
  if (!process.stdin.isTTY) {
    console.log('BuddyLiveGF 已注入（双击模式）。皮肤已在 WorkBuddy 页面内常驻，可关闭本窗口。');
    setTimeout(() => process.exit(0), 3000);
    return;
  }

  if (watch && mode === 'inject') {
    console.log('进入 --watch 常驻模式：监听新工作区窗口并自动注入（Ctrl+C 退出）。');
    const seen = new Set();
    const loop = async () => {
      while (true) {
        try {
          const targets = await listAppTargets(chosen.port);
          for (const t of targets) {
            if (seen.has(t.id)) continue;
            seen.add(t.id);
            const session = new CdpSession(t, chosen.port);
            await session.open();
            try {
              await session.send('Runtime.enable');
              await session.send('Page.enable');
              await applySkin(session, bootstrapSrc);
              console.log('  [watch] 新窗口注入 ->', t.url || t.title || '(untitled)');
            } finally { session.close(); }
          }
        } catch { /* 端口暂不可达，稍后重试 */ }
        await sleep(1500);
      }
    };
    loop().catch((e) => { console.error('watch 异常', e); process.exit(1); });
    return;
  }

  console.log('\n命令：corner | immersive -> 切换布局；theme -> 打印主题；exit -> 退出');
  process.stdin.on('data', async (buf) => {
    const cmd = buf.toString().trim();
    if (cmd === 'exit') process.exit(0);
    if (cmd === 'corner' || cmd === 'immersive') {
      await eachTarget(chosen.port, (s) => s.send('Runtime.evaluate', {
        expression: `window.__buddylive && window.__buddylive.setLayout('${cmd}')`,
        returnByValue: true,
      }));
      console.log('布局 ->', cmd);
    } else if (cmd === 'theme') {
      await eachTarget(chosen.port, async (s) => {
        const r = await s.send('Runtime.evaluate', {
          expression: 'window.__buddylive && window.__buddylive.detectDark()',
          returnByValue: true,
        });
        console.log('dark =', r && r.result && r.result.value);
      });
    } else {
      console.log('未知命令');
    }
  });
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
