// BuddyLiveGF 注入脚本（在 WorkBuddy 渲染进程内运行）
// 性能要点：
//  1) 静态 CSS 只注入一次；主题切换仅翻转 widget 的 class，绝不重写 <style>（避免 CSS 重解析）。
//  2) 主题检测用 O(1) 属性读取（data-vscode-theme-kind / theme-dark），不调用 getComputedStyle。
//  3) MutationObserver 用 rAF 合并、并做主题去重：没变就不碰 DOM。
//  4) 回调只改 widget 自身，绝不修改被观察的 documentElement，避免自触发死循环。
// 注意：本文件被 launcher 以字符串形式 eval 注入，禁止使用 Node API，只能使用浏览器全局。
(function () {
  if (window.__buddylive) return; // 已注入则跳过

  const STYLE_ID = 'buddylive-style';
  const WIDGET_ID = 'buddylive-gf';

  // 静态 CSS：主题差异全部用 .theme-dark / .theme-light 选择器表达，
  // 因此切主题 = 改 widget 的一个 class，CSS 引擎只做增量匹配，不重新解析整段样式。
  const CSS = `
#buddylive-gf{position:fixed;inset:0;z-index:2147483646;pointer-events:none;
  font-family:system-ui,sans-serif;overflow:hidden;}
#buddylive-gf .avatar{position:fixed;display:flex;align-items:center;justify-content:center;
  will-change:transform;transform:translateZ(0);}
/* 角落布局 */
#buddylive-gf.layout-corner .avatar{right:18px;bottom:18px;width:120px;height:120px;font-size:84px;
  filter:drop-shadow(0 4px 10px rgba(0,0,0,.15));}
/* 沉浸布局 */
#buddylive-gf.layout-immersive .avatar{right:6%;bottom:8%;width:240px;height:240px;font-size:200px;
  filter:drop-shadow(0 0 22px rgba(170,90,255,.6));}
#buddylive-gf.layout-immersive{background:radial-gradient(circle at 82% 90%,rgba(255,225,235,.28),transparent 60%);}
#buddylive-gf.theme-dark.layout-immersive{background:radial-gradient(circle at 82% 90%,rgba(120,60,200,.28),transparent 60%);}
/* 暖白女友 / 赛博女友：emoji 占位，后续替换为真实美术（建议内联 SVG，体积小、可 GPU 合成）*/
#buddylive-gf .avatar::before{content:"\1F90D";}            /* 🤍 */
#buddylive-gf.theme-dark .avatar::before{content:"\1F49C";} /* 💜 */
/* 仅用 transform/opacity 的轻微呼吸动画，跑在合成线程，不触发 layout/paint */
@keyframes blgf-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.03)}}
#buddylive-gf .avatar{animation:blgf-breathe 4s ease-in-out infinite;}
@media (prefers-reduced-motion: reduce){#buddylive-gf .avatar{animation:none}}
`;

  // O(1) 主题信号：WorkBuddy 在 documentElement 上暴露 data-vscode-theme-kind 与 theme-dark/theme-light
  function detectDark() {
    const de = document.documentElement;
    const kind = de.dataset && de.dataset.vscodeThemeKind;
    if (kind === 'dark') return true;
    if (kind === 'light') return false;
    if (de.classList.contains('theme-dark')) return true;
    if (de.classList.contains('theme-light')) return false;
    if (de.classList.contains('vs-dark')) return true;
    return false; // 兜底：浅色
  }

  let lastTheme = null;   // 'dark' | 'light'，用于去重
  let lastLayout = 'corner';
  let rafId = 0;

  function render() {
    rafId = 0;
    const theme = detectDark() ? 'dark' : 'light';
    if (theme === lastTheme) return; // 没变就完全不动 DOM/CSS
    lastTheme = theme;
    const w = document.getElementById(WIDGET_ID);
    if (w) w.className = 'buddylive-gf layout-' + lastLayout + ' theme-' + theme;
  }

  function scheduleRender() {
    if (rafId) return; // 合并一帧内的多次突变
    rafId = requestAnimationFrame(render);
  }

  function apply() {
    if (!document.getElementById(STYLE_ID)) {
      const s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = CSS;
      (document.head || document.documentElement).appendChild(s);
    }
    if (!document.getElementById(WIDGET_ID)) {
      const w = document.createElement('div');
      w.id = WIDGET_ID;
      const a = document.createElement('div');
      a.className = 'avatar';
      w.appendChild(a);
      document.body.appendChild(w);
    }
    render();
  }

  function setLayout(layout) {
    if (layout !== 'corner' && layout !== 'immersive') return;
    lastLayout = layout;
    const w = document.getElementById(WIDGET_ID);
    if (w && lastTheme != null) w.className = 'buddylive-gf layout-' + layout + ' theme-' + lastTheme;
  }

  // 只观察 documentElement 的 class / 主题属性；回调里从不修改 documentElement 自身
  const obs = new MutationObserver(scheduleRender);
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-vscode-theme-kind'],
  });

  window.__buddylive = { apply, setLayout, detectDark };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();
