// BuddyLiveGF Windows — launcher + CDP injector（性能优化版）
// 通过 Electron 本地回环调试端口注入皮肤脚本，不修改 WorkBuddy 安装包。
//
// 性能 / 体验要点：
//  - 幂等：端口已开则「热附连」（不杀进程、不重启，对应原版「热切换无需重启」）；
//    仅在端口未开时才带 --remote-debugging-port 重启一次。
//  - 显式绑定 127.0.0.1，避免监听 0.0.0.0（更安全，也少一次外部可达的端口占用）。
//  - 只向真正的工作区窗口注入，跳过 devtools / 扩展宿主等无关 page 目标。
//  - 每个目标仅建一条 CDP 会话并复用，后续布局/主题指令走 Runtime.evaluate。
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const DEBUG_PORT = 9222;
const APP_EXE = process.env.WORKBUDDY_EXE || 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe';
const BOOTSTRAP = path.join(__dirname, 'inject', 'bootstrap.js');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpReachable() {
  try { return await httpGetJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`); }
  catch (e) { return null; }
}

// 极简 CDP 会话：单条 WebSocket 上多路复用请求/响应
function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const queue = [];
  ws.on('open', () => { while (queue.length) ws.send(queue.shift()); });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      const msg = JSON.stringify({ id: mid, method, params });
      if (ws.readyState === 1) ws.send(msg); else queue.push(msg);
    });
  }
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(m.error) : p.resolve(m.result);
    }
  });
  return { ws, send, waitOpen: () => new Promise((r) => ws.on('open', r)) };
}

// 只保留真正的工作区窗口：排除 devtools、扩展宿主、about:blank 等
function isWorkbench(t) {
  if (t.type !== 'page' || !t.webSocketDebuggerUrl) return false;
  const u = (t.url || '').toLowerCase();
  if (/devtools|extension|electron\.js|about:blank/.test(u)) return false;
  return true;
}

async function waitForCDP() {
  for (let i = 0; i < 60; i++) {
    const v = await cdpReachable();
    if (v) return v;
    await sleep(500);
  }
  throw new Error('WorkBuddy CDP 未在端口 ' + DEBUG_PORT + ' 就绪');
}

async function main() {
  const bootstrapSrc = fs.readFileSync(BOOTSTRAP, 'utf8');

  // 1) 幂等：端口已开 → 热附连；否则重启并开端口（仅一次）
  let hot = await cdpReachable();
  if (!hot) {
    try { execSync('taskkill /IM WorkBuddy.exe /F', { stdio: 'ignore' }); } catch (e) { /* 没在跑 */ }
    await sleep(1000);
    spawn(APP_EXE, [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--remote-debugging-address=127.0.0.1`,
    ], { stdio: 'ignore' });
    console.log('WorkBuddy 已带调试端口重启');
    hot = await waitForCDP();
  } else {
    console.log('检测到已开启的调试端口，热附连（不重启）');
  }
  console.log('CDP:', hot.Browser, hot.ProtocolVersion);

  // 2) 注入（当前文档立即执行一次 + 之后导航自动生效）
  const targets = await httpGetJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
  const pages = targets.filter(isWorkbench);
  console.log('注入到', pages.length, '个工作区窗口');

  const sessions = [];
  for (const t of pages) {
    const s = cdpSession(t.webSocketDebuggerUrl);
    await s.waitOpen();
    await s.send('Runtime.enable');
    await s.send('Page.enable');
    await s.send('Runtime.evaluate', { expression: bootstrapSrc, returnByValue: true }); // 当前文档
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: bootstrapSrc });      // 未来导航
    sessions.push(s);
    console.log('  已注入 ->', t.url || t.title || '(untitled)');
  }

  console.log('\nBuddyLiveGF (Windows) 就绪。命令：');
  console.log('  corner | immersive   -> 切换布局');
  console.log('  theme                 -> 打印当前检测到的主题 (true=深色)');
  console.log('  exit                  -> 退出');

  process.stdin.on('data', async (buf) => {
    const cmd = buf.toString().trim();
    if (cmd === 'exit') process.exit(0);
    if (cmd === 'corner' || cmd === 'immersive') {
      for (const s of sessions) {
        await s.send('Runtime.evaluate', {
          expression: `window.__buddylive && window.__buddylive.setLayout('${cmd}')`,
          returnByValue: true,
        });
      }
      console.log('布局 ->', cmd);
    } else if (cmd === 'theme') {
      for (const s of sessions) {
        const r = await s.send('Runtime.evaluate', {
          expression: 'window.__buddylive && window.__buddylive.detectDark()',
          returnByValue: true,
        });
        console.log('dark =', r && r.result && r.result.value);
      }
    } else {
      console.log('未知命令');
    }
  });
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
