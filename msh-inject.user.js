// ==UserScript==
// @name         观影字幕助手 · 站内版
// @namespace    https://make3548-beep.github.io/movie-subtitle-helper/
// @version      1.0.0
// @description  在视频网站自己的播放页里直接出双语字幕：脚本与播放器同源所以能抓到声音，字幕画在播放器画面内下方。需自备阿里云百炼 API Key（只存在该站本地）。
// @author       movie-subtitle-helper
// @match        *://*/*
// @exclude      https://make3548-beep.github.io/movie-subtitle-helper/*
// @grant        none
// @run-at       document-idle
// @noframes     false
// ==/UserScript==

/* 观影字幕助手 · 站内版 v1.0.0
   在视频站自己的页面里运行（书签加载 / 油猴脚本）。脚本与播放器同源，所以能抓到声音，
   字幕直接画在站点播放器上，不用粘直链。切句/并发/覆盖前沿/翻译与主工具同一套判据。 */
(() => {
'use strict';
if (window.__mshInject) { window.__mshInject.toggle(); return; }

/* 书签是用户主动点的，直接挂载；油猴脚本每个页面都会跑，没播放器就不打扰，等播放器出现再挂载 */
const hasVideo = () => !!document.querySelector('video');
if (window.__mshForce || hasVideo()) boot();
else {
  const ob = new MutationObserver(() => { if (hasVideo()) { ob.disconnect(); clearTimeout(tid); boot(); } });
  ob.observe(document.documentElement, { childList: true, subtree: true });
  const tid = setTimeout(() => ob.disconnect(), 120000);
}

function boot() {
const VER = '1.0.0';
const BL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const S = { key: '', mode: 'both', mic: false };
try { Object.assign(S, JSON.parse(localStorage.getItem('msh_inject_cfg') || '{}')); } catch (e) {}
const saveCfg = () => { try { localStorage.setItem('msh_inject_cfg', JSON.stringify(S)); } catch (e) {} };

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
  'background:#14161b;border:1px solid #262a33;border-radius:12px;padding:12px;box-shadow:0 8px 32px rgba(0,0,0,.6);' +
  'font-family:' + FONT + ';color:#eef0f4;display:none;');
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
const statusEl = el('div', 'font-size:12px;color:#8b93a3;margin-top:8px;word-break:break-all;min-height:16px;', panel);
const hintEl = el('div', 'font-size:11px;color:#8b93a3;margin-top:6px;line-height:1.5;', panel,
  '先在站内点播放，再点「开始」。字幕画在播放器画面内下方，网页全屏也跟着走；iPhone 的系统原生全屏盖不住字幕，请用播放器自带的网页全屏。个别站禁止外部脚本时改用油猴脚本安装。');
const btnDestroy = el('button', BTN + 'margin-top:8px;padding:4px 8px;font-size:12px;background:transparent;color:#8b93a3;', panel, '移除本站字幕组件');

const overlay = el('div', 'position:fixed;z-index:' + (Z - 1) + ';pointer-events:none;display:none;text-align:center;overflow:hidden;');
const oEl = el('div', 'color:#fff;font-weight:500;line-height:1.35;margin-bottom:3px;display:none;text-shadow:' +
  '-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,-1px 0 0 #000,1px 0 0 #000,0 -1px 0 #000,0 1px 0 #000,0 2px 6px rgba(0,0,0,.85);', overlay);
const zEl = el('div', 'color:#fff;font-weight:700;line-height:1.35;display:none;text-shadow:' +
  '-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000,-1px 0 0 #000,1px 0 0 #000,0 -1px 0 #000,0 1px 0 #000,0 2px 6px rgba(0,0,0,.85);', overlay);

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.style.color = kind === 'err' ? '#ff6b6b' : kind === 'warn' ? '#ffb454' : kind === 'ok' ? '#3ecf8e' : '#8b93a3';
}
function syncMicBtn() {
  const on = rec.active ? !!micNode : S.mic;
  micBtn.textContent = '麦克风：' + (on ? '开' : '关');
  micBtn.style.background = on ? '#4f8cff' : 'transparent';
  micBtn.style.borderColor = on ? '#4f8cff' : '#262a33';
  micBtn.style.color = on ? '#fff' : '#8b93a3';
}
function uiHost() { return document.fullscreenElement || document.webkitFullscreenElement || document.body; }
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
  overlay.style.left = r.left + 'px'; overlay.style.top = r.top + 'px';
  overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
  const fs = Math.max(14, Math.round(r.width * 0.032));
  zEl.style.fontSize = fs + 'px'; oEl.style.fontSize = Math.round(fs * 0.76) + 'px';
  const gap = Math.max(28, Math.round(r.height * 0.09));
  oEl.style.position = 'absolute'; zEl.style.position = 'absolute';
  zEl.style.left = '6%'; zEl.style.right = '6%'; zEl.style.bottom = gap + 'px';
  oEl.style.left = '6%'; oEl.style.right = '6%'; oEl.style.bottom = (gap + fs * 1.35 + 3) + 'px';
}
const onFsChange = () => reparentUI();
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
  const chunkRaw = 10 * sr, minRaw = 2.6 * sr, silenceCut = 0.42 * sr;
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
    setStatus('识别运行中（静音切句，上限 10s/段）… 出句 ' + gotCount, 'ok');
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
function bindVideoEvents() {
  video.addEventListener('seeked', onSeeked); video.addEventListener('pause', onPause); video.addEventListener('play', onPlay);
  window.addEventListener('resize', onGeom); window.addEventListener('scroll', onGeom, true);
  document.addEventListener('fullscreenchange', onGeom);
}
function unbindVideoEvents() {
  if (video) { video.removeEventListener('seeked', onSeeked); video.removeEventListener('pause', onPause); video.removeEventListener('play', onPlay); }
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
    setStatus(video.paused ? '已就绪：播放器还是暂停的，点播放就开始出字幕。' : '识别运行中（静音切句，上限 10s/段）…', video.paused ? 'warn' : 'ok');
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
  document.removeEventListener('fullscreenchange', onFsChange);
  document.removeEventListener('webkitfullscreenchange', onFsChange);
  chip.remove(); panel.remove(); overlay.remove();
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

window.__mshInject = {
  version: VER,
  toggle: () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; },
  start, stop,
  destroy: () => btnDestroy.onclick(),
  _d
};
}
})();