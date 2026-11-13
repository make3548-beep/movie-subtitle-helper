/* 观影字幕助手 · 站内版 v1.0.0
   在视频站自己的页面里运行（书签加载 / 油猴脚本）。脚本与播放器同源，所以能抓到声音，
   字幕直接画在站点播放器上，不用粘直链。切句/并发/覆盖前沿/翻译与主工具同一套判据。 */
(() => {
'use strict';
/* 书签可以把主工具里配好的 Key 直接带过来：只存在本机书签里，不进任何 URL */
const carriedKey = window.__mshKey ? String(window.__mshKey).trim() : '';
if (carriedKey) { try { delete window.__mshKey; } catch (e) { window.__mshKey = ''; } }
if (window.__mshInject) { if (carriedKey) window.__mshInject.setKey(carriedKey); window.__mshInject.toggle(); return; }

/* 书签是用户主动点的，直接挂载；油猴脚本每个页面都会跑，没播放器就不打扰，等播放器出现再挂载 */
const hasVideo = () => !!document.querySelector('video');
if (window.__mshForce || hasVideo()) boot();
else {
  const ob = new MutationObserver(() => { if (hasVideo()) { ob.disconnect(); clearTimeout(tid); boot(); } });
  ob.observe(document.documentElement, { childList: true, subtree: true });
  const tid = setTimeout(() => ob.disconnect(), 120000);
}

function boot() {
const VER = '1.3.0';
const BL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const S = { key: '', mode: 'both', mic: false, hook: true };
try { Object.assign(S, JSON.parse(localStorage.getItem('msh_inject_cfg') || '{}')); } catch (e) {}
const saveCfg = () => { try { localStorage.setItem('msh_inject_cfg', JSON.stringify(S)); } catch (e) {} };
if (carriedKey) { S.key = carriedKey; saveCfg(); }

let video = null, boundVideo = null;
let ctx = null, srcNode = null, analyser = null, srcAnalyser = null, srcTap = null, srcLevelBuf = null;
let workletNode = null, procNode = null, micNode = null, micStream = null;
let sr = 48000, levelBuf = null;
let rawChunks = [], rmsChunks = [], totalRaw = 0;
const rec = { active: false, startVideoTime: 0, processedRaw: 0, timer: null };
let doneFrontier = 0, frontierTasks = [];
let asrEpoch = 0, inFlight = 0, waitQueue = [], flightCap = 2, asrGapMs = 1000, asrGateUntil = 0, okStreak = 0, pumpTimer = null;
let noiseFloor = 0.001, peakHold = 0.001, silentSec = 0, silentFromT = -1, micSilentSec = 0, micReverted = false, micUserToggled = false;
const lines = [], pending = [], trCache = new Map();
let sentCount = 0, gotCount = 0, asrSecs = 0, lastText = '';
let dispTimer = null, trTimer = null, posTimer = null;
const DEAD_ABS = 0.0006;

/* ============ 浮层 UI（全部 DOM，内联样式，避免被站点 CSS 带跑） ============ */
const Z = 2147483647;
const FONT = '-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif';
function el(tag, css, parent, text) {
  const n = document.createElement(tag);
  n.style.cssText = css;
  if (text != null) n.textContent = text;
  (parent || document.body).appendChild(n);
  return n;
}
const BTN = 'font-family:' + FONT + ';font-size:13px;line-height:1.4;padding:8px 10px;border-radius:8px;' +
  'border:1px solid #262a33;background:#1b1e25;color:#eef0f4;cursor:pointer;';
const chip = el('button', 'position:fixed;right:12px;bottom:12px;z-index:' + Z + ';' + BTN +
  'background:#4f8cff;border-color:#4f8cff;color:#fff;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.45);', null, '字幕');
const panel = el('div', 'position:fixed;right:12px;bottom:58px;z-index:' + Z + ';width:min(320px,calc(100vw - 24px));' +
  'max-height:calc(100vh - 90px);overflow-y:auto;overscroll-behavior:contain;' +
  'background:#14161b;border:1px solid #262a33;border-radius:12px;padding:12px;box-shadow:0 8px 32px rgba(0,0,0,.6);' +
  'font-family:' + FONT + ';color:#eef0f4;display:none;');
panel.className = 'mshScroll';
const head = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:8px;', panel);
el('b', 'font-size:14px;font-weight:600;', head, '站内字幕');
el('span', 'font-size:11px;color:#8b93a3;', head, 'v' + VER);
el('span', 'flex:1;', head);
const btnHide = el('button', BTN + 'padding:4px 8px;font-size:12px;', head, '收起');
el('label', 'display:block;font-size:12px;color:#8b93a3;margin:6px 0 4px;', panel, '阿里云百炼 API Key（与主工具同一个，只存本站本地）');
const keyInput = el('input', 'width:100%;box-sizing:border-box;background:#1b1e25;color:#eef0f4;border:1px solid #262a33;' +
  'border-radius:8px;padding:8px 10px;font-size:13px;outline:none;', panel);
keyInput.type = 'password'; keyInput.placeholder = 'sk-...'; keyInput.value = S.key;
keyInput.oninput = () => { S.key = keyInput.value.trim(); saveCfg(); };
const row1 = el('div', 'display:flex;gap:8px;margin-top:8px;', panel);
const modeSel = el('select', 'flex:1;min-width:0;background:#1b1e25;color:#eef0f4;border:1px solid #262a33;border-radius:8px;' +
  'padding:8px;font-size:13px;outline:none;', row1);
[['both', '双语'], ['zh', '仅中文'], ['orig', '仅原文']].forEach(([v, t]) => {
  const o = el('option', '', modeSel, t); o.value = v;
});
modeSel.value = S.mode;
modeSel.onchange = () => { S.mode = modeSel.value; saveCfg(); };
const micBtn = el('button', BTN + 'flex:0 0 auto;', row1);
const runBtn = el('button', BTN + 'width:100%;margin-top:8px;background:#4f8cff;border-color:#4f8cff;color:#fff;font-weight:600;', panel, '开始');
const row2 = el('div', 'display:flex;gap:8px;margin-top:8px;', panel);
const fsBtn2 = el('button', BTN + 'flex:1;font-size:12px;', row2, '网页全屏');
const hookBtn = el('button', BTN + 'flex:1;font-size:12px;', row2);
const statusEl = el('div', 'font-size:12px;color:#8b93a3;margin-top:8px;word-break:break-all;min-height:16px;', panel);
const hintEl = el('div', 'font-size:11px;color:#8b93a3;margin-top:6px;line-height:1.5;', panel,
  '先在站内点播放，再点「开始」。横屏看片照常点播放器的全屏按钮：脚本会把它接到自己的网页全屏层，再把手机横过来，字幕跟着画面走，底部有播放/进度/字号/字幕开关。个别站禁止外部脚本时改用油猴脚本安装。');
const btnDestroy = el('button', BTN + 'margin-top:8px;padding:4px 8px;font-size:12px;background:transparent;color:#8b93a3;', panel, '移除本站字幕组件');

const overlay = el('div', 'position:fixed;z-index:' + (Z - 1) + ';pointer-events:none;display:none;text-align:center;overflow:hidden;');
const oEl = el('div', 'color:#fff;font-weight:500;line-height:1.35;margin-bottom:3px;display:none;transition:bottom .18s ease;text-shadow:' +
  '-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,-1px 0 0 #000,1px 0 0 #000,0 -1px 0 #000,0 1px 0 #000,0 2px 6px rgba(0,0,0,.85);', overlay);
const zEl = el('div', 'color:#fff;font-weight:700;line-height:1.35;display:none;transition:bottom .18s ease;text-shadow:' +
  '-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,-1px 0 0 #000,1px 0 0 #000,0 -1px 0 #000,0 1px 0 #000,0 2px 6px rgba(0,0,0,.85);', overlay);

/* ============ 自己的网页全屏：接管站点的全屏按钮，画面留在网页里，字幕才盖得上 ============ */
let webfs = false, fsReal = false, fsScale = 1, fsSubOn = true, fsBarTimer = null, fsUiTimer = null, fsBarShown = true;
let fsHome = null, fsNext = null, fsStyle = null, fsControls = false, fsOverflow = '', fsInternal = false;
const fsHooks = [];
const fsStyleEl = el('style', '');
fsStyleEl.textContent = '.mshRange{-webkit-appearance:none;appearance:none;height:4px;border-radius:3px;background:#2a3346;outline:none}' +
  '.mshRange::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:#4f8cff;border:2px solid #0b0f18;box-shadow:0 0 8px rgba(79,140,255,.85);cursor:pointer}' +
  '.mshRange::-moz-range-thumb{width:15px;height:15px;border-radius:50%;background:#4f8cff;border:2px solid #0b0f18;cursor:pointer}' +
  '.mshFsBtn:active{transform:scale(.94);background:rgba(79,140,255,.32)}' +
  '.mshScroll{scrollbar-width:thin;scrollbar-color:#4f8cff #14161b}' +
  '.mshScroll::-webkit-scrollbar{width:8px}.mshScroll::-webkit-scrollbar-track{background:#14161b;border-radius:8px}' +
  '.mshScroll::-webkit-scrollbar-thumb{background:#2b3548;border-radius:8px}.mshScroll::-webkit-scrollbar-thumb:hover{background:#4f8cff}';
const fsBox = el('div', 'position:fixed;inset:0;height:100dvh;z-index:' + (Z - 2) + ';display:none;align-items:center;justify-content:center;' +
  'background:radial-gradient(120% 120% at 50% 0%,#0d1424 0%,#05070c 60%,#020306 100%);overflow:hidden;touch-action:manipulation;');
const fsBar = el('div', 'position:absolute;left:0;right:0;bottom:0;z-index:5;padding:10px 12px calc(10px + env(safe-area-inset-bottom));' +
  'display:flex;flex-direction:column;gap:8px;font-family:' + FONT + ';color:#eef0f4;' +
  'background:linear-gradient(to top,rgba(3,5,10,.94),rgba(3,5,10,.72) 60%,transparent);' +
  'transition:opacity .25s ease,transform .25s ease;', fsBox);
const fsRow1 = el('div', 'display:flex;align-items:center;gap:10px;', fsBar);
const fsSeek = el('input', 'flex:1;min-width:0;', fsRow1);
fsSeek.type = 'range'; fsSeek.className = 'mshRange'; fsSeek.min = 0; fsSeek.max = 1000; fsSeek.value = 0;
const fsTime = el('span', 'font-size:12px;color:#9fb0cc;font-variant-numeric:tabular-nums;white-space:nowrap;', fsRow1, '0:00 / 0:00');
const fsRow2 = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;', fsBar);
const FSB = 'font-family:' + FONT + ';font-size:12px;line-height:1.4;padding:7px 10px;border-radius:9px;border:1px solid #2b3548;' +
  'background:rgba(20,26,40,.9);color:#e8eefc;cursor:pointer;transition:background .15s,border-color .15s,transform .1s;';
function fsb(parent, text, extra) { const b = el('button', FSB + (extra || ''), parent, text); b.className = 'mshFsBtn'; return b; }
const fsPlay = fsb(fsRow2, '播放', 'min-width:64px;font-weight:600;');
const fsRun = fsb(fsRow2, '识别：关');
const fsMic = fsb(fsRow2, '麦克风：关');
const fsMode = el('select', FSB + 'padding:7px 8px;', fsRow2);
[['both', '双语'], ['zh', '仅中文'], ['orig', '仅原文']].forEach(([v, t]) => { const o = el('option', '', fsMode, t); o.value = v; });
fsMode.value = S.mode;
const fsSmaller = fsb(fsRow2, '字小');
const fsBigger = fsb(fsRow2, '字大');
const fsAuto = fsb(fsRow2, '自动字号');
const fsSub = fsb(fsRow2, '字幕：开');
const fsExit = fsb(fsRow2, '退出全屏', 'margin-left:auto;background:#4f8cff;border-color:#4f8cff;color:#fff;font-weight:600;');
const fsTopExit = el('button', 'position:absolute;top:calc(10px + env(safe-area-inset-top));right:12px;z-index:6;' + FSB +
  'background:rgba(8,11,18,.72);backdrop-filter:blur(6px);', fsBox, '退出全屏');
fsTopExit.className = 'mshFsBtn';
const fsToast = el('div', 'position:absolute;left:50%;top:calc(12px + env(safe-area-inset-top));transform:translateX(-50%);z-index:6;' +
  'max-width:min(560px,86vw);padding:7px 12px;border-radius:10px;border:1px solid #2b3548;background:rgba(8,11,18,.82);' +
  'backdrop-filter:blur(6px);font-family:' + FONT + ';font-size:12px;line-height:1.5;color:#cfe0ff;text-align:center;' +
  'opacity:0;transition:opacity .3s ease;pointer-events:none;', fsBox);
const fsChip = el('button', 'position:fixed;right:70px;bottom:12px;z-index:' + Z + ';' + BTN +
  'background:rgba(20,26,40,.92);border-color:#4f8cff;color:#cfe0ff;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.45);', null, '全屏');
let fsToastTimer = null;
function toast(msg, kind) {
  fsToast.textContent = msg;
  fsToast.style.color = kind === 'err' ? '#ff9b9b' : kind === 'warn' ? '#ffd08a' : kind === 'ok' ? '#8ff0c4' : '#cfe0ff';
  fsToast.style.opacity = '1';
  clearTimeout(fsToastTimer);
  fsToastTimer = setTimeout(() => { fsToast.style.opacity = '0'; }, 4200);
}

/* 原生全屏入口要在改写原型之前拿到，自己的全屏层用它，避免被自己的接管逻辑绕回来 */
const NAT = {
  req: Element.prototype.requestFullscreen || Element.prototype.webkitRequestFullscreen || Element.prototype.webkitRequestFullScreen,
  exit: Document.prototype.exitFullscreen || Document.prototype.webkitExitFullscreen || Document.prototype.webkitCancelFullScreen
};
let fsInline = null, fsInlineWk = null, fsPanelWas = false, fsSelfExit = false, fsFitTimer = null, fsFitTimer2 = null;

function fsClock(s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function fitFsVideo() {
  if (!webfs || !video) return;
  const w = fsBox.clientWidth || innerWidth, h = fsBox.clientHeight || innerHeight;
  const ar = (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 16 / 9;
  let vw = w, vh = w / ar; if (vh > h) { vh = h; vw = h * ar; }
  const st = video.style;   // 站点常用 !important 锁死播放器尺寸，这里必须同级压制
  st.setProperty('width', Math.round(vw) + 'px', 'important');
  st.setProperty('height', Math.round(vh) + 'px', 'important');
  st.setProperty('max-width', 'none', 'important'); st.setProperty('max-height', 'none', 'important');
  st.setProperty('object-fit', 'contain', 'important');
  st.setProperty('margin', '0', 'important'); st.setProperty('position', 'relative', 'important');
  st.setProperty('transform', 'none', 'important'); st.setProperty('flex', '0 0 auto', 'important');
}
function syncFsBar() {
  if (!video) return;
  fsPlay.textContent = video.paused ? '播放' : '暂停';
  fsMode.value = S.mode;
  fsSub.textContent = '字幕：' + (fsSubOn ? '开' : '关');
  fsRun.textContent = '识别：' + (rec.active ? '开' : '关');
  fsRun.style.borderColor = rec.active ? '#3ecf8e' : '#2b3548';
  fsRun.style.color = rec.active ? '#8ff0c4' : '#e8eefc';
  const mon = rec.active ? !!micNode : S.mic;
  fsMic.textContent = '麦克风：' + (mon ? '开' : '关');
  fsMic.style.borderColor = mon ? '#4f8cff' : '#2b3548';
  fsMic.style.color = mon ? '#cfe0ff' : '#e8eefc';
  const d = video.duration || 0;
  if (document.activeElement !== fsSeek) fsSeek.value = d ? Math.round(video.currentTime / d * 1000) : 0;
  fsTime.textContent = fsClock(video.currentTime) + ' / ' + fsClock(d);
}
function showFsBar() {
  fsBarShown = true;
  fsBar.style.opacity = '1'; fsBar.style.transform = 'translateY(0)'; fsBar.style.pointerEvents = 'auto';
  placeOverlay();
  clearTimeout(fsBarTimer);
  fsBarTimer = setTimeout(() => {
    if (webfs && video && !video.paused) {
      fsBarShown = false;
      fsBar.style.opacity = '0'; fsBar.style.transform = 'translateY(12px)'; fsBar.style.pointerEvents = 'none';
      placeOverlay();
    }
  }, 3500);
}
function scheduleFit() {   // iOS 转屏时 innerWidth 会晚几拍才更新，补两次重量
  clearTimeout(fsFitTimer); clearTimeout(fsFitTimer2);
  fsFitTimer = setTimeout(() => { if (webfs) { fitFsVideo(); placeOverlay(); } }, 220);
  fsFitTimer2 = setTimeout(() => { if (webfs) { fitFsVideo(); placeOverlay(); } }, 700);
}
function enterFs() {
  if (webfs) return;
  if (!video) video = pickVideo();
  if (!video) { setStatus('没找到播放器：先在站内点播放，再点「全屏」。', 'err'); return; }
  fsHome = video.parentNode; fsNext = video.nextSibling;
  fsStyle = video.getAttribute('style'); fsControls = video.controls;
  fsInline = video.getAttribute('playsinline'); fsInlineWk = video.getAttribute('webkit-playsinline');
  fsPanelWas = panel.style.display !== 'none';
  const wasPlaying = !video.paused;
  fsOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
  video.controls = false;
  video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');   // 少了它 iPhone 一 play 就跳系统播放器
  fsBox.style.display = 'flex'; fsBox.appendChild(video);
  webfs = true; fsBarShown = true;
  fsChip.style.display = 'none'; chip.style.display = 'none'; panel.style.display = 'none';
  video.addEventListener('loadedmetadata', fitFsVideo);
  fitFsVideo(); reparentUI(); syncFsBar(); showFsBar();
  if (wasPlaying && video.paused) video.play().catch(() => {});
  clearInterval(fsUiTimer);
  fsUiTimer = setInterval(() => {
    if (webfs && video && video.parentNode !== fsBox) { fsBox.appendChild(video); fitFsVideo(); }   // 站点脚本把播放器搬回去时抢回来
    syncFsBar(); placeOverlay();
  }, 500);
  fsReal = false;
  try {
    const p = NAT.req && NAT.req.call(fsBox);
    if (p && p.then) p.then(() => { fsReal = true; reparentUI(); placeOverlay(); }).catch(() => {});
    else if ((document.fullscreenElement || document.webkitFullscreenElement) === fsBox) fsReal = true;
  } catch (e) {}
  try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch (e) {}
  scheduleFit();
  toast('网页全屏：把手机横过来，字幕跟着画面走。', 'ok');
  if (!rec.active && S.key) start();
  else setStatus('已进网页全屏：字幕就在画面里，退出点右上「退出全屏」。', 'ok');
}
function exitFs() {
  if (!webfs) return;
  webfs = false; fsBarShown = false;
  clearTimeout(fsBarTimer); clearTimeout(fsFitTimer); clearTimeout(fsFitTimer2);
  clearInterval(fsUiTimer); fsUiTimer = null;
  if (fsReal) { fsReal = false; try { const p = NAT.exit && NAT.exit.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
  if (video) {
    video.removeEventListener('loadedmetadata', fitFsVideo);
    if (fsHome && fsHome.isConnected) fsHome.insertBefore(video, fsNext && fsNext.parentNode === fsHome ? fsNext : null);
    else document.body.appendChild(video);
    if (fsStyle === null) video.removeAttribute('style'); else video.setAttribute('style', fsStyle);
    video.controls = fsControls;
    if (fsInline === null) video.removeAttribute('playsinline'); else video.setAttribute('playsinline', fsInline);
    if (fsInlineWk === null) video.removeAttribute('webkit-playsinline'); else video.setAttribute('webkit-playsinline', fsInlineWk);
    fsSelfExit = true;   // 通知站点播放器退出全屏状态，同时别让自家的系统全屏警告误报
    try { video.dispatchEvent(new Event('webkitendfullscreen')); } catch (e) {}
    fsSelfExit = false;
  }
  fsBox.style.display = 'none'; document.body.style.overflow = fsOverflow;
  fsChip.style.display = ''; chip.style.display = ''; panel.style.display = fsPanelWas ? 'block' : 'none';
  fsSubOn = true; overlay.style.visibility = 'visible'; fsToast.style.opacity = '0';
  reparentUI(); placeOverlay(); syncFsBar();
  setStatus('已退出网页全屏，回到站点页面。', 'ok');
}
fsChip.onclick = enterFs;
fsBtn2.onclick = () => { panel.style.display = 'none'; enterFs(); };
fsExit.onclick = exitFs; fsTopExit.onclick = exitFs;
fsPlay.onclick = () => { if (!video) return; if (video.paused) video.play().catch(() => {}); else video.pause(); syncFsBar(); showFsBar(); };
fsRun.onclick = () => { if (rec.active) stop(); else start(); syncFsBar(); showFsBar(); };
fsMic.onclick = async () => { await micBtn.onclick(); syncFsBar(); showFsBar(); };
fsSeek.oninput = () => { if (!video || !video.duration) return; video.currentTime = fsSeek.value / 1000 * video.duration; syncFsBar(); showFsBar(); };
fsMode.onchange = () => { S.mode = fsMode.value; saveCfg(); modeSel.value = S.mode; showFsBar(); };
fsSmaller.onclick = () => { fsScale = Math.max(0.6, +(fsScale - 0.15).toFixed(2)); placeOverlay(); showFsBar(); toast('字号 ' + Math.round(fsScale * 100) + '%'); };
fsBigger.onclick = () => { fsScale = Math.min(2.2, +(fsScale + 0.15).toFixed(2)); placeOverlay(); showFsBar(); toast('字号 ' + Math.round(fsScale * 100) + '%'); };
fsAuto.onclick = () => { fsScale = 1; placeOverlay(); showFsBar(); toast('字号回到自动'); };
fsSub.onclick = () => { fsSubOn = !fsSubOn; overlay.style.visibility = fsSubOn ? 'visible' : 'hidden'; syncFsBar(); showFsBar(); };
fsBox.addEventListener('pointerdown', showFsBar); fsBox.addEventListener('pointermove', showFsBar);
fsBox.addEventListener('touchstart', showFsBar, { passive: true });
fsBox.addEventListener('dblclick', e => { if (e.target === fsBox || e.target === video) fsPlay.onclick(); });
const onFsKey = e => {
  if (!webfs || !video) return;
  const t = e.target && e.target.tagName;
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
  if (e.key === 'Escape') exitFs();
  else if (e.key === ' ') { e.preventDefault(); fsPlay.onclick(); }
  else if (e.key === 'ArrowRight') { video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); showFsBar(); }
  else if (e.key === 'ArrowLeft') { video.currentTime = Math.max(0, video.currentTime - 5); showFsBar(); }
};
document.addEventListener('keydown', onFsKey);
const onFsResize = () => { if (!webfs) return; fitFsVideo(); placeOverlay(); scheduleFit(); };
window.addEventListener('resize', onFsResize);
window.addEventListener('orientationchange', onFsResize);
if (window.visualViewport) visualViewport.addEventListener('resize', onFsResize);

/* 接管站点的全屏调用：iPhone 上站点按钮走 video.webkitEnterFullscreen()，画面一交给系统播放器网页字幕就没了。
   只改道「播放器本身或包着播放器的容器」，页面其它元素的全屏照旧走原生。 */
function fsTarget(node) {
  if (!node || node.nodeType !== 1) return null;
  if (isMediaEl(node)) return (node === video || !video) ? node : null;
  if (node === document.documentElement || node === document.body) return null;
  const v = video || pickVideo();
  return v && node.contains(v) ? v : null;
}
function fsPatch(proto, names, make) {
  names.forEach(name => {
    const orig = proto && proto[name];
    if (typeof orig !== 'function') return;
    try { proto[name] = make(orig); fsHooks.push([proto, name, orig]); } catch (e) {}
  });
}
function fsInstallHook() {
  if (fsHooks.length) return;
  const enter = orig => function (...a) {
    if (S.hook) {
      const v = fsTarget(this);
      if (v) { if (!video) video = v; if (webfs) exitFs(); else enterFs(); return Promise.resolve(); }
    }
    return orig.apply(this, a);
  };
  const exit = orig => function (...a) {
    if (S.hook && webfs) { exitFs(); return Promise.resolve(); }
    return orig.apply(this, a);
  };
  const VP = window.HTMLVideoElement && HTMLVideoElement.prototype;
  const EP = window.Element && Element.prototype;
  const DP = window.Document && Document.prototype;
  fsPatch(VP, ['webkitEnterFullscreen', 'webkitEnterFullScreen'], enter);
  fsPatch(EP, ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen', 'mozRequestFullScreen', 'msRequestFullscreen'], enter);
  fsPatch(VP, ['webkitExitFullscreen', 'webkitExitFullScreen'], exit);
  fsPatch(DP, ['exitFullscreen', 'webkitExitFullscreen', 'webkitCancelFullScreen', 'mozCancelFullScreen', 'msExitFullscreen'], exit);
}
function fsRemoveHook() { while (fsHooks.length) { const [o, n, f] = fsHooks.pop(); try { o[n] = f; } catch (e) {} } }
fsInstallHook();
function syncHookBtn() {
  hookBtn.textContent = '接管站点全屏：' + (S.hook ? '开' : '关');
  hookBtn.style.background = S.hook ? '#4f8cff' : 'transparent';
  hookBtn.style.borderColor = S.hook ? '#4f8cff' : '#262a33';
  hookBtn.style.color = S.hook ? '#fff' : '#8b93a3';
}
hookBtn.onclick = () => {
  S.hook = !S.hook; saveCfg(); syncHookBtn();
  setStatus(S.hook ? '已接管站点的全屏按钮：点它进网页全屏，字幕跟着画面。' : '已交还站点原来的全屏行为（iPhone 上会进系统播放器，字幕盖不上）。', S.hook ? 'ok' : 'warn');
};
syncHookBtn();

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.style.color = kind === 'err' ? '#ff6b6b' : kind === 'warn' ? '#ffb454' : kind === 'ok' ? '#3ecf8e' : '#8b93a3';
  if (webfs && (kind === 'err' || kind === 'warn')) toast(msg, kind);   // 全屏里面板收起来了，报错/警告要看得见；例行出句状态不刷屏
}
function syncMicBtn() {
  const on = rec.active ? !!micNode : S.mic;
  micBtn.textContent = '麦克风：' + (on ? '开' : '关');
  micBtn.style.background = on ? '#4f8cff' : 'transparent';
  micBtn.style.borderColor = on ? '#4f8cff' : '#262a33';
  micBtn.style.color = on ? '#fff' : '#8b93a3';
  if (webfs) syncFsBar();
}
function isMediaEl(e) { return !!e && /^(VIDEO|AUDIO)$/.test(e.tagName); }
function uiHost() {
  if (webfs) return fsBox;   // 自己的全屏层：真全屏时只有它的子树会渲染，字幕必须住在里面
  const h = document.fullscreenElement || document.webkitFullscreenElement;
  // 系统全屏会把 video 自己当全屏元素，而 video 是替换元素：塞进去的节点实测尺寸恒为 0×0，还可能被播放器 teardown 丢掉
  return isMediaEl(h) ? document.body : (h || document.body);
}
function reparentUI() {
  const h = uiHost();
  if (overlay.parentNode !== h) h.appendChild(overlay);
  if (chip.parentNode !== h) h.appendChild(chip);
  if (panel.parentNode !== h) h.appendChild(panel);
}
function placeOverlay() {
  reparentUI();
  if (!video) return;
  const r = video.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) { overlay.style.display = 'none'; return; }
  if (rec.active) overlay.style.display = 'block';
  overlay.style.zIndex = String(webfs ? 4 : Z - 1);
  overlay.style.left = r.left + 'px'; overlay.style.top = r.top + 'px';
  overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
  const fs = Math.max(11, Math.round(Math.max(14, r.width * 0.032) * fsScale));   // 自动字号保住 14px 可读地板，手动缩到 60% 时不低于 11px
  zEl.style.fontSize = fs + 'px'; oEl.style.fontSize = Math.max(10, Math.round(fs * 0.76)) + 'px';
  let gap = Math.max(24, Math.round(r.height * 0.09));
  if (webfs && fsBarShown) {   // 控制栏露出来时把字幕抬到栏上方，别被压住
    const need = Math.round(r.bottom - fsBar.getBoundingClientRect().top + 12);
    if (need > gap) gap = Math.min(Math.round(r.height * 0.5), need);
  }
  oEl.style.position = 'absolute'; zEl.style.position = 'absolute';
  zEl.style.left = '6%'; zEl.style.right = '6%'; zEl.style.bottom = gap + 'px';
  oEl.style.left = '6%'; oEl.style.right = '6%'; oEl.style.bottom = (gap + fs * 1.35 + 3) + 'px';
}
const sysFsWarn = () => setStatus('这个站的全屏走了系统播放器，网页字幕盖不上去。请点右下「全屏」按钮（或面板里的「网页全屏」），再把手机横过来。', 'warn');
const onFsChange = () => {
  const h = document.fullscreenElement || document.webkitFullscreenElement;
  if (webfs && fsReal && h !== fsBox) { exitFs(); return; }   // 浏览器/Esc 自己退掉了真全屏，DOM 也要跟着还原
  reparentUI(); placeOverlay();
  if (isMediaEl(h)) sysFsWarn();
};
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);
chip.onclick = () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; };
btnHide.onclick = () => { panel.style.display = 'none'; };
panel.style.display = S.key ? 'none' : 'block';
syncMicBtn();

/* ============ 音频捕获：AudioWorklet 优先，CSP 禁 blob worker 时退 ScriptProcessor ============ */
const WORKLET = `
class MshCap extends AudioWorkletProcessor{
  constructor(){ super(); this.buf=new Float32Array(8192); this.n=0; }
  process(inputs){
    const ch=inputs[0]&&inputs[0][0];
    if(ch){ for(let i=0;i<ch.length;i++){ this.buf[this.n++]=ch[i];
      if(this.n===this.buf.length){ this.port.postMessage(this.buf.slice(0)); this.n=0; } } }
    return true;
  }
}
registerProcessor('msh-cap', MshCap);`;

function pickVideo() {
  if (webfs && video && video.isConnected) return video;   // 全屏层里就认这一个，别让站点别的 video 抢走
  const vs = [...document.querySelectorAll('video')].filter(v => (v.currentSrc || v.src) && v.getBoundingClientRect().width > 40);
  if (!vs.length) return null;
  vs.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return rb.width * rb.height - ra.width * ra.height; });
  return vs.find(v => !v.paused) || vs[0];
}
async function ensureGraph() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    sr = ctx.sampleRate;
    analyser = ctx.createAnalyser(); analyser.fftSize = 2048; levelBuf = new Float32Array(2048);
    srcAnalyser = ctx.createAnalyser(); srcAnalyser.fftSize = 1024; srcLevelBuf = new Float32Array(1024);
    srcTap = ctx.createGain(); srcTap.gain.value = 0;
    srcAnalyser.connect(srcTap); srcTap.connect(ctx.destination);
    try {
      const u = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(u);
      workletNode = new AudioWorkletNode(ctx, 'msh-cap');
      workletNode.port.onmessage = e => onAudioData(e.data);
    } catch (e) {
      procNode = ctx.createScriptProcessor(8192, 1, 1);
      procNode.onaudioprocess = e => {
        onAudioData(new Float32Array(e.inputBuffer.getChannelData(0)));
        e.outputBuffer.getChannelData(0).fill(0);   // 静音落地：只拉处理，不多出一路声音
      };
      procNode.connect(ctx.destination);
    }
  }
  await ctx.resume();
  if (srcNode && boundVideo && boundVideo !== video) {   // SPA 换了播放器元素
    try { srcNode.connect(ctx.destination); } catch (e) {}
    try { srcNode.disconnect(); } catch (e) {}
    srcNode = null;
  }
  if (!srcNode && video) {
    try { srcNode = ctx.createMediaElementSource(video); boundVideo = video; } catch (e) { srcNode = null; }
  }
}
function connectCapture() {
  try { srcNode && srcNode.disconnect(); } catch (e) {}
  try { micNode && micNode.disconnect(); } catch (e) {}
  const sink = workletNode || procNode;
  if (micNode) { micNode.connect(analyser); if (sink) micNode.connect(sink); }
  if (srcNode) {
    if (!micNode) { srcNode.connect(analyser); if (sink) srcNode.connect(sink); }
    srcNode.connect(srcAnalyser);
    srcNode.connect(ctx.destination);   // 站点照常出声
  }
}
async function enableMic() {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
  micNode = ctx.createMediaStreamSource(micStream);
  resetClock();
}
function disableMic() {
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  micNode = null;
}

/* ============ 切句 / 调度 / 识别（与主工具同判据） ============ */
function onAudioData(f32) {
  if (!rec.active) return;
  let s = 0; for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i];
  const rms = Math.sqrt(s / f32.length);
  if (!micNode && rms < 0.0008 && video && (video.paused || video.seeking || video.readyState < 3)) return;
  rawChunks.push(f32); totalRaw += f32.length; rmsChunks.push(rms); trackNoiseFloor(rms);
}
function slice16k(a, b) {
  const len = b - a, raw = new Float32Array(len);
  let base = 0, g = 0;
  for (const c of rawChunks) {
    const cEnd = base + c.length, s = Math.max(a, base), e = Math.min(b, cEnd);
    if (e > s) { raw.set(c.subarray(s - base, e - base), g); g += e - s; }
    base = cEnd; if (base >= b) break;
  }
  if (sr === 16000) return raw;
  const ratio = sr / 16000, outLen = Math.floor(len / ratio), out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) { const p = i * ratio, i0 = p | 0, fr = p - i0; const x = raw[i0] || 0, y = raw[i0 + 1] || 0; out[i] = x + (y - x) * fr; }
  return out;
}
function pruneRawSafe() {
  const keepFrom = Math.max(0, rec.processedRaw - 30 * sr);
  let base = 0, i = 0;
  while (i < rawChunks.length) { const c = rawChunks[i]; if (base + c.length <= keepFrom) { base += c.length; i++; } else break; }
  if (i > 0) { rawChunks = rawChunks.slice(i); rmsChunks = rmsChunks.slice(i); }
}
function resetClock() {
  rawChunks = []; rmsChunks = []; totalRaw = 0; rec.processedRaw = 0;
  rec.startVideoTime = (video && video.currentTime) || 0;
  doneFrontier = 0; frontierTasks.length = 0;
}
function voiceTh() { return Math.max(0.0008, noiseFloor * 2.5, peakHold * 0.15); }
function trackNoiseFloor(rms) {
  if (rms < voiceTh()) { noiseFloor += (rms - noiseFloor) * (rms < noiseFloor ? 0.15 : 0.02); noiseFloor = Math.max(0.0002, Math.min(0.02, noiseFloor)); }
  peakHold = Math.min(0.3, Math.max(rms, peakHold * 0.998));
}
function scanVoiced(a, b) {
  let base = 0, last = a, mx = 0; const th = voiceTh();
  for (let i = 0; i < rawChunks.length; i++) {
    const cEnd = base + rawChunks[i].length;
    if (cEnd > a && base < b) { const v = rmsChunks[i]; if (v > mx) mx = v; if (v >= th) last = cEnd; }
    base = cEnd; if (base >= b) break;
  }
  return { last: Math.min(last, b), max: mx };
}
function voicedSpan(a, b) {
  let base = 0, s = -1, e = -1; const th = voiceTh();
  for (let i = 0; i < rawChunks.length; i++) {
    const cEnd = base + rawChunks[i].length;
    if (cEnd > a && base < b && rmsChunks[i] >= th) { if (s < 0) s = Math.max(base, a); e = Math.min(cEnd, b); }
    base = cEnd; if (base >= b) break;
  }
  if (s < 0) return [0, (b - a) / sr];
  const dur = (b - a) / sr;
  return [Math.max(0, (s - a) / sr - 0.12), Math.min(dur, (e - a) / sr + 0.12)];
}
function tick() {
  if (!rec.active || !video) return;
  const upto = Math.floor(totalRaw - 0.1 * sr);
  const chunkRaw = 5 * sr, minRaw = 2.6 * sr, silenceCut = 0.42 * sr;   // 上限 5s：连续对白时更跟手（用户实测），有静音照样提前切句
  while (upto - rec.processedRaw > 0.2 * sr) {
    const segStart = rec.processedRaw, span = upto - segStart;
    const scan = scanVoiced(segStart, upto), hasVoice = scan.last > segStart;
    if (hasVoice && span >= minRaw && upto - scan.last >= silenceCut) { sendTask(segStart, upto, false); rec.processedRaw = upto; pruneRawSafe(); continue; }
    if (!hasVoice && scan.max < DEAD_ABS && span >= 2 * sr) { sendTask(segStart, upto, true); rec.processedRaw = upto; pruneRawSafe(); continue; }
    if (span >= chunkRaw) { sendTask(segStart, upto, false); rec.processedRaw = upto; pruneRawSafe(); continue; }
    break;
  }
  if (!analyser) return;
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  analyser.getFloatTimeDomainData(levelBuf);
  let sum = 0; for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
  const rms = Math.sqrt(sum / levelBuf.length);
  let srcRms = 0;
  if (srcAnalyser && srcNode) {
    srcAnalyser.getFloatTimeDomainData(srcLevelBuf);
    let s2 = 0; for (let i = 0; i < srcLevelBuf.length; i++) s2 += srcLevelBuf[i] * srcLevelBuf[i];
    srcRms = Math.sqrt(s2 / srcLevelBuf.length);
  }
  if (!micNode && !video.paused) {
    if (rms < DEAD_ABS) {
      silentSec++;
      if (silentFromT < 0) silentFromT = video.currentTime || 0;
      if (silentSec >= 8 && (video.currentTime || 0) - silentFromT > 2 && !video.seeking && video.readyState >= 3) {
        silentSec = 0; silentFromT = -1;
        enableMic().then(() => { connectCapture(); syncMicBtn(); setStatus('站内播放器声音抓不到（跨域媒体），已改用麦克风拾音。', 'warn'); })
          .catch(() => setStatus('抓不到站内声音且麦克风未授权：请在浏览器允许麦克风，或回主工具粘直链。', 'err'));
      }
    } else { silentSec = 0; silentFromT = -1; }
  }
  if (micNode && !video.paused) {
    const srcUsable = srcNode && srcRms > DEAD_ABS * 4;
    const srcStrong = srcUsable && srcRms > 0.01;
    const micBad = rms < DEAD_ABS || (srcStrong && rms < srcRms * 0.2);
    if (micBad) {
      micSilentSec++;
      if (micSilentSec >= 6 && srcUsable && !micReverted && !micUserToggled) {
        micReverted = true; disableMic(); connectCapture(); syncMicBtn();
        setStatus('麦克风声音太弱，已自动改用站内播放器声音（时间轴不变）。', 'warn');
      }
    } else micSilentSec = 0;
  }
}
function mergeFrontier() {
  frontierTasks.sort((a, b) => a.start - b.start);
  let go = true;
  while (go) {
    go = false;
    for (let i = 0; i < frontierTasks.length; i++) {
      const t = frontierTasks[i];
      if (!t.done) continue;
      if (t.end <= doneFrontier) { frontierTasks.splice(i, 1); go = true; break; }
      if (t.start <= doneFrontier && t.end > doneFrontier) { doneFrontier = t.end; frontierTasks.splice(i, 1); go = true; break; }
    }
  }
}
function pump() {
  if (pumpTimer) return;
  while (inFlight < flightCap && waitQueue.length) {
    const wait = asrGateUntil - Date.now();
    if (wait > 0) { pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, wait); return; }
    inFlight++; asrGateUntil = Date.now() + asrGapMs; runASR(waitQueue.shift());
  }
}
function sendTask(a, b, skip) {
  const t = { start: a, end: b, done: false, dur: (b - a) / sr, tStart: rec.startVideoTime + a / sr, audio: null };
  frontierTasks.push(t); mergeFrontier();
  if (skip) { t.done = true; mergeFrontier(); return; }
  t.audio = slice16k(a, b); asrSecs += t.dur;
  waitQueue.push(t); pump();
}
function encodeWAV(f32) {
  const n = f32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7FFF, true); }
  return new Blob([buf], { type: 'audio/wav' });
}
function blobToDataURL(b) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('音频编码读取失败')); r.readAsDataURL(b); }); }
function cleanText(t) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  if (t.length < 2) return '';
  if (/[<>{}[\]|~`^$%&@*#]/.test(t)) return '';
  if (!/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0400-\u04ffA-Za-z0-9]/.test(t)) return '';
  const ok = (t.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0400-\u04ffA-Za-z0-9\s，。！？、,.!?…—：:；;「」（）()"'’“”]/g) || []).length;
  if (ok / t.length < 0.7) return '';
  if (/^(.)\1{3,}$/.test(t)) return '';
  return t;
}
let cloudTranscribe = async audio16k => {
  if (!S.key) throw new Error('未填阿里云百炼 API Key');
  const dataUri = await blobToDataURL(encodeWAV(audio16k));
  const body = { model: 'qwen3-asr-flash', stream: false, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] }] };
  let r;
  try { r = await fetch(BL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.key }, body: JSON.stringify(body) }); }
  catch (e) { throw new Error('网络请求失败（可能被该站 CSP 拦截或无网络）：' + e.message); }
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { const d = await r.json(); const em = (d.error && d.error.message) || d.message; if (em) msg += ' ' + em; } catch (e) {}
    if (r.status === 401) msg = 'Key 无效：' + msg;
    else if (r.status === 429) msg = '限流/额度不足，稍等再试：' + msg;
    throw new Error(msg);
  }
  const d = await r.json();
  return String((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || d.text || '').trim();
};
async function runASR(task) {
  const myEpoch = asrEpoch;
  try {
    let text = '', attempt = 0;
    for (;;) {
      try { text = cleanText(await cloudTranscribe(task.audio)); okStreak++; if (okStreak >= 12 && flightCap < 2) flightCap = 2; if (okStreak % 6 === 0) asrGapMs = Math.max(1000, asrGapMs - 200); break; }
      catch (err) {
        const m = String((err && err.message) || err);
        if (myEpoch === asrEpoch && attempt < 3 && /429|rate ?limit|限流|throttl/i.test(m)) {
          attempt++; okStreak = 0; flightCap = 1; asrGapMs = Math.min(6000, Math.round(asrGapMs * 1.8)); asrGateUntil = Date.now() + asrGapMs;
          setStatus('识别被限流（429），已自动放慢重试，句子不会丢。', 'warn');
          await new Promise(r => setTimeout(r, 1200 * attempt));
          if (myEpoch !== asrEpoch) break;
          continue;
        }
        throw err;
      }
    }
    sentCount++; lastText = text ? '「' + text.slice(0, 40) + '」' : '(无有效语音)';
    if (myEpoch === asrEpoch && text) handleTranscript({ text }, task);
    setStatus('识别运行中（静音切句，上限 5s/段）… 出句 ' + gotCount, 'ok');
  } catch (err) {
    setStatus('识别出错：' + ((err && err.message) || err), 'err');
  }
  task.done = true; inFlight = Math.max(0, inFlight - 1); mergeFrontier();
  if (myEpoch === asrEpoch) pump(); else waitQueue.length = 0;
}
function handleTranscript(out, task) {
  const vs = voicedSpan(task.start, task.end);
  const text = String(out.text || '').replace(/\s+/g, ' ').trim();
  if (!text || text === '.' || text === '谢谢观看。') return;
  if (vs[0] >= task.dur - 0.1) return;
  addLine(task.tStart + vs[0], task.tStart + Math.min(vs[1], task.dur + 0.5), text);
}
function addLine(t0, t1, orig) {
  const last = lines[lines.length - 1];
  if (last && last.orig === orig && t0 - last.t1 < 1.2) { last.t1 = Math.max(last.t1, t1); return; }
  const line = { t0, t1, orig, zh: null };
  let i = lines.length; while (i > 0 && lines[i - 1].t0 > t0) i--;
  lines.splice(i, 0, line); pending.push(line); gotCount++;
}
function fetchTO(url, opt, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 8000);
  return fetch(url, { ...(opt || {}), signal: c.signal }).finally(() => clearTimeout(t));
}
let translateBailian = async texts => {
  if (!S.key) throw new Error('未填百炼 API Key');
  const r = await fetchTO(BL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.key },
    body: JSON.stringify({ model: 'qwen-flash', temperature: 0, messages: [
      { role: 'system', content: '你是影视字幕翻译引擎。把用户发来的每一行原文（可能是日语/英语/韩语/俄语等）翻译成简体中文。要求：输出行数与输入完全一致，每行一条译文，不要编号、不要解释、不要合并行。' },
      { role: 'user', content: texts.join('\n') }] })
  }, 20000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  return (d.choices[0].message.content || '').trim().split('\n').map(s => s.replace(/^\d+[.、:：]\s*/, '').trim());
};
let translateMyMemory = async texts => {
  const res = [];
  for (const t of texts) {
    let src = 'en';
    if (/[぀-ヿ]/.test(t)) src = 'ja'; else if (/[가-힯]/.test(t)) src = 'ko';
    const r = await fetchTO('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(t) + '&langpair=' + src + '|zh-CN', {}, 8000);
    const d = await r.json();
    res.push(((d.responseData && d.responseData.translatedText) || '').trim());
  }
  return res;
};
function flushTranslate() {
  if (!pending.length) return;
  const batch = pending.splice(0, 6);
  (async () => {
    const texts = batch.map(l => l.orig);
    const cands = texts.map(t => trCache.get(t));
    const needIdx = []; for (let i = 0; i < texts.length; i++) if (cands[i] == null) needIdx.push(i);
    if (needIdx.length) {
      const need = needIdx.map(i => texts[i]);
      let res = null;
      for (const fn of [translateBailian, translateMyMemory]) {
        try { res = await fn(need); break; } catch (e) {}
      }
      if (res) needIdx.forEach((idx, k) => { const v = (res[k] || '').trim(); cands[idx] = v || texts[idx]; trCache.set(texts[idx], cands[idx]); });
      else needIdx.forEach(idx => { cands[idx] = texts[idx]; });
    }
    batch.forEach((l, i) => { l.zh = cands[i]; });
  })();
}
function display() {
  if (!video) return;
  const cur = video.currentTime;
  let hit = null;
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].t0 <= cur) { hit = lines[i]; break; } }
  if (hit && cur > hit.t1 + 8) hit = null;
  if (hit) {
    const zh = hit.zh == null ? '…' : (hit.zh || hit.orig);
    if (S.mode !== 'zh') { oEl.textContent = hit.orig; oEl.style.display = 'block'; } else oEl.style.display = 'none';
    if (S.mode !== 'orig') { zEl.textContent = zh; zEl.style.display = 'block'; } else zEl.style.display = 'none';
  } else { oEl.style.display = 'none'; zEl.style.display = 'none'; }
}

/* ============ 时间轴重对齐 / 开始 / 停止 ============ */
let pausedAt = 0;
const onSeeked = () => {
  if (!rec.active) return;
  const drift = Math.abs((video.currentTime || 0) - (rec.startVideoTime + totalRaw / sr));
  if (drift < 1.0) return;
  resetClock(); asrEpoch++; inFlight = 0; waitQueue.length = 0;
  setStatus('进度已变动，字幕时间轴重新对齐。', 'warn');
};
const onPause = () => { if (rec.active) pausedAt = Date.now(); };
const onPlay = () => {
  if (rec.active && pausedAt && Date.now() - pausedAt > 1500) {
    pausedAt = 0; asrEpoch++; resetClock();
    setStatus('暂停过，字幕时间轴重新对齐。', 'warn');
  }
};
const onGeom = () => placeOverlay();
const onSysFsEnd = () => { placeOverlay(); if (!webfs && !fsSelfExit) sysFsWarn(); };   // iOS 原生全屏不一定派发 document 的 fullscreenchange，只有这两个事件可靠
function bindVideoEvents() {
  video.addEventListener('seeked', onSeeked); video.addEventListener('pause', onPause); video.addEventListener('play', onPlay);
  video.addEventListener('webkitendfullscreen', onSysFsEnd);
  window.addEventListener('resize', onGeom); window.addEventListener('scroll', onGeom, true);
  document.addEventListener('fullscreenchange', onGeom);
}
function unbindVideoEvents() {
  if (video) { video.removeEventListener('seeked', onSeeked); video.removeEventListener('pause', onPause); video.removeEventListener('play', onPlay);
    video.removeEventListener('webkitendfullscreen', onSysFsEnd); }
  window.removeEventListener('resize', onGeom); window.removeEventListener('scroll', onGeom, true);
  document.removeEventListener('fullscreenchange', onGeom);
}
async function start() {
  video = pickVideo();
  if (!video) { setStatus('没找到播放器：先在站内点播放，再点「开始」。', 'err'); return; }
  runBtn.disabled = true;
  try {
    await ensureGraph();
    if (!srcNode) { await enableMic(); setStatus('站内媒体跨域抓不到声音，已改用麦克风拾音（请外放出声）。', 'warn'); }
    else if (S.mic) { await enableMic(); }
    connectCapture();
    if (!S.key) throw new Error('未填百炼 Key：在上面粘贴（与主工具同一个 Key）');
    resetClock();
    rec.active = true; asrEpoch++;
    micReverted = false; micUserToggled = false; silentSec = 0; silentFromT = -1; micSilentSec = 0;
    bindVideoEvents();
    rec.timer = setInterval(tick, 250);
    dispTimer = setInterval(display, 200);
    trTimer = setInterval(flushTranslate, 600);
    posTimer = setInterval(placeOverlay, 500);
    placeOverlay();
    runBtn.textContent = '停止';
    runBtn.style.background = 'transparent'; runBtn.style.borderColor = '#ff6b6b'; runBtn.style.color = '#ff6b6b';
    setStatus(video.paused ? '已就绪：播放器还是暂停的，点播放就开始出字幕。' : '识别运行中（静音切句，上限 5s/段）…', video.paused ? 'warn' : 'ok');
  } catch (e) {
    setStatus('启动失败：' + ((e && e.message) || e), 'err');
  }
  runBtn.disabled = false; syncMicBtn();
}
function stop() {
  rec.active = false;
  clearInterval(rec.timer); clearInterval(dispTimer); clearInterval(trTimer); clearInterval(posTimer);
  dispTimer = trTimer = posTimer = null;
  waitQueue.length = 0; inFlight = 0;
  unbindVideoEvents();
  disableMic();
  if (ctx) connectCapture();   // 保留 srcNode→destination，站点继续出声
  overlay.style.display = 'none'; oEl.style.display = 'none'; zEl.style.display = 'none';
  runBtn.textContent = '开始';
  runBtn.style.background = '#4f8cff'; runBtn.style.borderColor = '#4f8cff'; runBtn.style.color = '#fff';
  setStatus('已停止。', 'warn'); syncMicBtn();
}
runBtn.onclick = () => rec.active ? stop() : start();
micBtn.onclick = async () => {
  if (rec.active) {
    micUserToggled = true;
    try {
      if (micNode) { disableMic(); } else { await enableMic(); }
      connectCapture(); syncMicBtn();
    } catch (e) { setStatus('麦克风开启失败：' + e.message, 'err'); }
  } else { S.mic = !S.mic; saveCfg(); syncMicBtn(); }
};
btnDestroy.onclick = () => {
  stop();
  exitFs();
  fsRemoveHook();
  document.removeEventListener('fullscreenchange', onFsChange);
  document.removeEventListener('webkitfullscreenchange', onFsChange);
  document.removeEventListener('keydown', onFsKey);
  window.removeEventListener('resize', onFsResize);
  window.removeEventListener('orientationchange', onFsResize);
  if (window.visualViewport) visualViewport.removeEventListener('resize', onFsResize);
  clearTimeout(fsBarTimer); clearTimeout(fsFitTimer); clearTimeout(fsFitTimer2); clearTimeout(fsToastTimer);
  chip.remove(); panel.remove(); overlay.remove(); fsBox.remove(); fsChip.remove(); fsStyleEl.remove();
  delete window.__mshInject;
};

/* 探针/调试钩子：与主工具回归探针同一手法 */
const _d = {};
[['ctx', v => ctx = v, () => ctx], ['analyser', v => analyser = v, () => analyser],
 ['srcAnalyser', v => srcAnalyser = v, () => srcAnalyser], ['srcNode', v => srcNode = v, () => srcNode],
 ['workletNode', v => workletNode = v, () => workletNode], ['procNode', v => procNode = v, () => procNode],
 ['micNode', v => micNode = v, () => micNode], ['micStream', v => micStream = v, () => micStream],
 ['sr', v => sr = v, () => sr], ['levelBuf', v => levelBuf = v, () => levelBuf],
 ['srcLevelBuf', v => srcLevelBuf = v, () => srcLevelBuf],
 ['rawChunks', v => rawChunks = v, () => rawChunks], ['rmsChunks', v => rmsChunks = v, () => rmsChunks],
 ['totalRaw', v => totalRaw = v, () => totalRaw], ['doneFrontier', v => doneFrontier = v, () => doneFrontier],
 ['inFlight', v => inFlight = v, () => inFlight], ['flightCap', v => flightCap = v, () => flightCap],
 ['asrGapMs', v => asrGapMs = v, () => asrGapMs], ['asrGateUntil', v => asrGateUntil = v, () => asrGateUntil],
 ['asrEpoch', v => asrEpoch = v, () => asrEpoch], ['noiseFloor', v => noiseFloor = v, () => noiseFloor],
 ['peakHold', v => peakHold = v, () => peakHold], ['sentCount', v => sentCount = v, () => sentCount],
 ['gotCount', v => gotCount = v, () => gotCount], ['asrSecs', v => asrSecs = v, () => asrSecs],
 ['video', v => video = v, () => video], ['boundVideo', v => boundVideo = v, () => boundVideo],
 ['cloudTranscribe', v => cloudTranscribe = v, () => cloudTranscribe],
 ['translateBailian', v => translateBailian = v, () => translateBailian],
 ['translateMyMemory', v => translateMyMemory = v, () => translateMyMemory]
].forEach(([k, set, get]) => Object.defineProperty(_d, k, { set, get, configurable: true }));
_d.rec = rec; _d.lines = lines; _d.pending = pending; _d.waitQueue = waitQueue; _d.frontierTasks = frontierTasks; _d.S = S;
_d.feed = onAudioData; _d.tick = tick; _d.flushTranslate = flushTranslate; _d.placeOverlay = placeOverlay; _d.display = display;
_d.fsBox = fsBox; _d.fsBar = fsBar; _d.fsHooks = fsHooks;
_d.enterFs = enterFs; _d.exitFs = exitFs; _d.fitFsVideo = fitFsVideo; _d.syncFsBar = syncFsBar;
[['webfs', () => webfs], ['fsReal', () => fsReal], ['fsScale', () => fsScale], ['fsBarShown', () => fsBarShown]]
  .forEach(([k, get]) => Object.defineProperty(_d, k, { get, configurable: true }));

window.__mshInject = {
  version: VER,
  toggle: () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; },
  setKey: k => { S.key = String(k || '').trim(); saveCfg(); keyInput.value = S.key; },
  start, stop, enterFs, exitFs,
  destroy: () => btnDestroy.onclick(),
  _d
};
}
})();