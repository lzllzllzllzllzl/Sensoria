/* ===================================================================
 * app.js — 美妆助手 · Beauty AI 无障碍版（核心逻辑）
 *
 * 七大增强功能：
 *  P1 图片上传/拍照（唤起相机或相册）+ 缩略图
 *  P2 判断结果展示区（结论 / 置信度 / 理由）
 *  P3 语音播报（window.speechSynthesis）+ 重新播报
 *  P4 振动反馈（颜色 + 质地双维度 navigator.vibrate）
 *  P5 美妆垂直语义（色号 / 颜色 / 质地 / 匹配原因 / 建议）
 *  P6 本地缓存 + 美妆库（localStorage，相同产品秒出）
 *  P7 全流程延伸（保存产品 / 推荐搭配 / 上妆指引）
 * ================================================================== */

// ==================== 全局状态 ====================
let currentMode = "voice";
let currentStream = null;
let currentResult = null;            // 拍照/识别结果（产品卡用）
let history = [];
let recognition = null;
let isListening = false;

let lastJudgmentResult = null;       // 上传判断结果（用于重播）
let hasUploadedImage = false;         // 是否已上传图片
let currentFingerprint = null;        // 当前上传图片的指纹（用于缓存匹配）
let cachedLibraryItem = null;         // 命中本地美妆库的缓存项
let currentJudgmentSaved = false;     // 当前结果是否已保存
let judgeMode = 'product';             // 'product' 看产品 | 'person' 看人
let lastJudgmentMode = 'product';      // 最近一次结果的模式（用于重播）
let judgePromptSource = 'preset';      // 'preset' 来自下拉预设 | 'custom' 来自用户手填

const LIB_KEY = "beauty_ai_library_v1";

// ==================== 模式切换 ====================
function setMode(mode) {
  currentMode = mode;
  document.getElementById('mode-voice').classList.toggle('active', mode === 'voice');
  document.getElementById('mode-touch').classList.toggle('active', mode === 'touch');
  document.body.classList.toggle('voice-mode', mode === 'voice');
  document.body.classList.toggle('touch-mode', mode === 'touch');

  const descEl = document.getElementById('mode-desc');
  const cameraHint = document.getElementById('camera-hint');
  const swatchStrip = document.getElementById('swatch-strip');

  if (mode === 'voice') {
    descEl.textContent = '当前为语音模式：全程语音引导，简洁操作，无需看屏幕';
    if (cameraHint) cameraHint.textContent = '将口红对准手机，我会语音引导你';
    if (swatchStrip) swatchStrip.style.display = 'none';
    speak('已切换到语音模式。全程语音引导，你只需听着操作就行。');
  } else {
    descEl.textContent = '当前为触控模式：完整取景框和色卡对比，适合低视力用户';
    if (cameraHint) cameraHint.textContent = '将口红对准取景框中心';
    if (swatchStrip) swatchStrip.style.display = 'flex';
    renderSwatches();
    speak('已切换到触控模式。屏幕上会显示色卡帮助你校准颜色。');
  }

  vibrate(mode === 'voice' ? [50] : [80, 40, 80]);
}

function renderSwatches() {
  const strip = document.getElementById('swatch-strip');
  strip.innerHTML = PRODUCTS.map(p =>
    `<div class="swatch" style="background:${p.shade}" title="${p.name}" onclick="quickPick(${p.id})"></div>`
  ).join('');
}

function quickPick(id) {
  const product = PRODUCTS.find(p => p.id === id);
  if (product) {
    currentResult = product;
    addToHistory(product);
    showResult(product);
    goTo('result');
  }
}

// ==================== 导航 ====================
function goTo(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');

  if (screenId === 'camera') {
    startCamera();
  } else {
    stopCamera();
  }

  if (screenId === 'question') {
    setTimeout(() => speak('按住麦克风按钮提问。可以问：这是什么颜色？显白吗？适合什么肤质？'), 400);
  }

  if (screenId === 'history') {
    renderHistory();
  }

  if (screenId === 'library') {
    renderLibrary();
  }

  if (screenId === 'home') {
    setTimeout(() => speak('已返回主页。'), 200);
  }
}

// ==================== 状态栏 ====================
function showStatus(msg) {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg;
  bar.classList.add('show');
  setTimeout(() => bar.classList.remove('show'), 3000);
}

// ==================== 摄像头 ====================
async function startCamera() {
  try {
    const constraints = {
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    };
    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    document.getElementById('video').srcObject = currentStream;
    document.getElementById('camera-placeholder').style.display = 'none';
    if (currentMode === 'voice') {
      speak('摄像头已开启。请将口红对准手机，点击屏幕下半部分拍照。');
    }
  } catch (err) {
    console.error('摄像头失败:', err);
    document.getElementById('camera-placeholder').innerHTML =
      '<p style="color:#FF6B6B;">摄像头未启动</p><p style="font-size:0.85rem;">请在设置中允许摄像头权限</p>';
    speak('摄像头启动失败，请检查权限设置后重试。');
  }
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
}

// ==================== 拍照识别 ====================
function captureAndAnalyze() {
  const video = document.getElementById('video');
  const canvas = document.getElementById('canvas');

  if (!currentStream) {
    speak('摄像头未启动，请允许权限后重试');
    return;
  }

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);

  const cx = Math.floor(canvas.width / 2);
  const cy = Math.floor(canvas.height / 2);
  const imgData = ctx.getImageData(cx - 5, cy - 5, 10, 10);
  const rgb = getAverageRGB(imgData);
  const matched = matchColor(rgb);
  currentResult = { ...matched, capturedRGB: rgb };
  addToHistory(matched);
  showResult(matched);
  goTo('result');
}

function getAverageRGB(imgData) {
  const d = imgData.data;
  let r = 0, g = 0, b = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i]; g += d[i+1]; b += d[i+2];
  }
  return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
}

function matchColor(target) {
  let best = PRODUCTS[0], minD = Infinity;
  for (const p of PRODUCTS) {
    const d = Math.sqrt(
      Math.pow(target[0]-p.rgb[0], 2) +
      Math.pow(target[1]-p.rgb[1], 2) +
      Math.pow(target[2]-p.rgb[2], 2)
    );
    if (d < minD) { minD = d; best = p; }
  }
  return best;
}

// ==================== 结果（拍照识别） ====================
function showResult(p) {
  document.getElementById('res-name').textContent = p.name;
  document.getElementById('res-dot').style.background = p.shade;
  document.getElementById('res-color').textContent = p.colorName;
  document.getElementById('res-shade').textContent = p.shade;
  document.getElementById('res-texture').textContent = p.texture;
  document.getElementById('res-desc').textContent = p.desc;

  const msg = `识别结果：${p.name}，${p.colorName}，${p.texture}质地。${p.desc}`;
  setTimeout(() => {
    speak(msg);
    vibrateTexture(getTextureKey(p.texture));
  }, 400);
}

function getTextureKey(t) {
  if (t.includes('哑光')) return 'matte';
  if (t.includes('丝绒')) return 'velvet';
  if (t.includes('滋润') || t.includes('水润')) return 'moist';
  return 'default';
}

function replayResult() {
  if (currentResult) {
    const p = currentResult;
    const msg = `${p.name}，${p.colorName}，${p.texture}质地。${p.desc}`;
    speak(msg);
    vibrateTexture(getTextureKey(p.texture));
  }
}

// ==================== 历史 ====================
function addToHistory(p) {
  history.unshift({ ...p, time: new Date().toLocaleString('zh-CN') });
  if (history.length > 20) history.pop();
}

function renderHistory() {
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  if (history.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = history.map((item, i) => `
    <div class="history-card" onclick="replayHistoryItem(${i})">
      <div class="top-row">
        <div class="dot" style="background:${item.shade}"></div>
        <div class="name">${item.name}</div>
      </div>
      <div class="meta">${item.colorName} · ${item.texture}</div>
      <div class="time">${item.time}</div>
    </div>
  `).join('');
}

function replayHistoryItem(i) {
  const item = history[i];
  if (item) {
    currentResult = item;
    speak(`${item.name}，${item.colorName}，${item.texture}质地。${item.desc}`);
    vibrateTexture(getTextureKey(item.texture));
  }
}

// ==================== TTS ====================
function speak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 0.9;
  u.volume = 1;
  const voices = window.speechSynthesis.getVoices();
  const zh = voices.find(v => v.lang.startsWith('zh'));
  if (zh) u.voice = zh;
  window.speechSynthesis.speak(u);
}

// ==================== ASR ====================
function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;
  recognition = new SR();
  recognition.lang = 'zh-CN';
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onstart = () => {
    isListening = true;
    document.getElementById('mic-btn').classList.add('listening');
    document.getElementById('voice-status').textContent = '正在听...';
  };
  recognition.onresult = (e) => {
    const r = e.results[0];
    const t = r[0].transcript;
    if (r.isFinal) {
      document.getElementById('voice-status').textContent = `你问的是：${t}`;
      processQuestion(t);
    } else {
      document.getElementById('voice-status').textContent = t + '...';
    }
  };
  recognition.onerror = () => {
    isListening = false;
    document.getElementById('mic-btn').classList.remove('listening');
    document.getElementById('voice-status').textContent = '没听清，请再试一次';
    speak('没听清，请再试一次');
  };
  recognition.onend = () => {
    isListening = false;
    document.getElementById('mic-btn').classList.remove('listening');
  };
  return true;
}

function startListening() {
  if (!recognition && !initSpeechRecognition()) {
    speak('当前浏览器不支持语音识别');
    return;
  }
  if (!isListening) {
    try { recognition.start(); vibrate([50]); } catch(e) {}
  }
}

function stopListening() {
  if (recognition && isListening) recognition.stop();
}

// ==================== 问答 ====================
function askQuestion(q) {
  document.getElementById('voice-status').textContent = `你问的是：${q}`;
  processQuestion(q);
  vibrate([50]);
}

function processQuestion(q) {
  const text = q.toLowerCase();
  let answer = '';

  if (!currentResult) {
    answer = '请先拍一个产品，我才能回答。你可以点击拍产品按钮开始识别。';
  } else if (text.includes('颜色') || text.includes('什么色')) {
    answer = `${currentResult.name}的颜色是${currentResult.colorName}，色号${currentResult.shade}。${currentResult.desc}`;
  } else if (text.includes('显白') || text.includes('白吗')) {
    answer = currentResult.whiteEffect;
  } else if (text.includes('肤质') || text.includes('油皮') || text.includes('干皮') || text.includes('适合')) {
    answer = `${currentResult.name} ${currentResult.skinType}。质地${currentResult.texture}。`;
    if (text.includes('油皮')) answer += '油皮建议先做好唇部打底。';
    else if (text.includes('干皮')) answer += currentResult.texture.includes('哑光')
      ? '哑光对干皮不太友好，建议先涂润唇膏。' : '这个质地对干皮友好。';
  } else if (text.includes('质地') || text.includes('哑光') || text.includes('滋润')) {
    answer = `${currentResult.name}的质地是${currentResult.texture}。${currentResult.desc}`;
  } else if (text.includes('推荐') || text.includes('怎么样') || text.includes('好用')) {
    answer = `${currentResult.name}非常受欢迎。${currentResult.desc} 显白效果：${currentResult.whiteEffect}`;
  } else {
    answer = `${currentResult.name}，${currentResult.colorName}，${currentResult.texture}。你可以问：什么颜色？显白吗？适合什么肤质？`;
  }

  document.getElementById('answer-text').textContent = answer;
  document.getElementById('answer-area').style.display = 'block';
  speak(answer);
  if (text.includes('显白')) vibrate([100, 30, 100, 30, 100]);
  else if (text.includes('质地')) vibrateTexture('matte');
}

// ==================== 振动 ====================
function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// 质地维度振动
function vibrateTexture(tKey) {
  vibrate(VIBRATION_BY_TEXTURE[tKey] || VIBRATION_BY_TEXTURE.default);
}

// 颜色 + 质地 双维度振动（P4 跨感官翻译）
function vibrateJudgment(result) {
  const cKey = colorCategory(result.colorDesc);
  const tKey = textureCategory(result.textureDesc);
  const cPat = VIBRATION_BY_COLOR[cKey] || VIBRATION_BY_COLOR.default;
  const tPat = VIBRATION_BY_TEXTURE[tKey] || VIBRATION_BY_TEXTURE.default;
  // 颜色振动 → 间隔 → 质地振动
  vibrate(cPat.concat([80]).concat(tPat));
}

// ================================================================
// P1+P2+P3+P4+P5+P6+P7：图片上传 → 判断 → 结果 → 语音 → 振动 → 美妆库
// ================================================================

// 显示判断命题（随模式切换预设角度 + 自定义输入）
function updatePrompt() {
  const sel = document.getElementById('preset-select');
  const ta = document.getElementById('custom-prompt');
  if (!sel || !ta) return;
  const presets = (judgeMode === 'person') ? PRESET_QUESTIONS_PERSON : PRESET_QUESTIONS_PRODUCT;
  sel.innerHTML = presets.map(q =>
    `<option value="${q.replace(/"/g, '&quot;')}">${q}</option>`
  ).join('');
  ta.value = presets[0];
  const label = document.getElementById('preset-label');
  if (label) label.textContent = (judgeMode === 'person') ? '① 选择诊断角度（可选）' : '① 选择判断角度（可选）';
  refreshPromptSource();
}

// 选择预设 → 填入输入框（用户可继续改写）
function onPresetChange() {
  const sel = document.getElementById('preset-select');
  const ta = document.getElementById('custom-prompt');
  if (sel && ta) ta.value = sel.value;
  refreshPromptSource();
}

// 用户在文本框里手填 → 标记为「自定义问题」
function onPromptInput() {
  refreshPromptSource();
}

// 实时判断当前命题来源：下拉预设（框内文字 == 选项）还是用户手填（不同）
function refreshPromptSource() {
  const sel = document.getElementById('preset-select');
  const ta = document.getElementById('custom-prompt');
  const badge = document.getElementById('prompt-source');
  if (!sel || !ta || !badge) return;
  const isPreset = ta.value.trim() !== '' && ta.value.trim() === sel.value.trim();
  judgePromptSource = isPreset ? 'preset' : 'custom';
  if (isPreset) {
    badge.textContent = '📋 来自下拉预设';
    badge.className = 'prompt-source preset';
  } else {
    badge.textContent = '✏️ 来自你的手填';
    badge.className = 'prompt-source custom';
  }
}

// 取当前生效的判断命题（优先用输入框内容，空则回退首个预设）
function getActivePrompt() {
  const ta = document.getElementById('custom-prompt');
  const v = (ta && ta.value || '').trim();
  if (v) return v;
  const sel = document.getElementById('preset-select');
  if (sel && sel.value) return sel.value;
  return (judgeMode === 'person') ? PROMPT_PERSON : PROMPT_PRODUCT;
}

function initPrompt() {
  updatePrompt();
}

// 双模式切换（拍产品 / 拍自己）
function setJudgeMode(mode) {
  judgeMode = mode;
  document.getElementById('mode-product').classList.toggle('active', mode === 'product');
  document.getElementById('mode-person').classList.toggle('active', mode === 'person');
  updatePrompt();
  resetJudgmentUI();
  if (mode === 'person') {
    speak('已切换到「拍自己」模式，上传一张你的自拍照，我来分析肤质和脸型。');
    vibrate([60, 40, 60]);
  } else {
    speak('已切换到「拍产品」模式，上传口红照片，我来识别色号和质地。');
    vibrate([80, 30, 80]);
  }
}

// 计算图片指纹（用于本地缓存命中）
function computeFingerprint(imgEl) {
  try {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const ctx = c.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; }
    return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
  } catch (e) {
    return [128, 128, 128];
  }
}

function fpDistance(a, b) {
  return Math.sqrt(
    Math.pow(a[0]-b[0], 2) + Math.pow(a[1]-b[1], 2) + Math.pow(a[2]-b[2], 2)
  );
}

// 指纹 → 确定性结果索引（相同图片永远得到相同判断）
function fingerprintSeed(fp) {
  return (fp[0] * 3 + fp[1] * 7 + fp[2] * 13) % MOCK_RESULTS.length;
}

// 文件上传处理（P1）
function bindFileInput() {
  const input = document.getElementById('file-input');
  input.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = function(evt) {
        showThumbnail(evt.target.result);
      };
      reader.readAsDataURL(file);
    }
  });
}

// 显示缩略图 + 指纹计算 + 美妆库缓存命中检测（P1 + P6）
function showThumbnail(src) {
  const thumb = document.getElementById('thumb');
  const status = document.getElementById('upload-status');
  const area = document.getElementById('upload-area');

  thumb.src = src;
  thumb.classList.add('show');
  status.textContent = '✅ 已上传';
  status.classList.add('uploaded');
  area.classList.add('has-image');
  hasUploadedImage = true;

  // 重置上一次结果展示
  resetJudgmentUI();

  // 计算指纹并检测本地美妆库命中（按当前模式匹配）
  const probe = new Image();
  probe.onload = function () {
    currentFingerprint = computeFingerprint(probe);
    const hit = findInLibrary(currentFingerprint, judgeMode);
    cachedLibraryItem = hit;
    const badge = document.getElementById('cache-badge');
    if (hit) {
      badge.textContent = '⚡ 来自我的美妆库 · 秒出结果';
      badge.classList.add('show');
      speak('图片已上传，我在你的美妆库里找到了同款，可以直接出结果。');
    } else {
      badge.classList.remove('show');
      speak(judgeMode === 'person'
        ? '图片已上传，请点击开始判断按钮，我来帮你分析肤质和脸型。'
        : '图片已上传，请点击开始判断按钮。');
    }
  };
  probe.src = src;

  vibrate([80]);
}

// 加载示例图片
function loadExampleImage() {
  showThumbnail(EXAMPLE_IMAGE);
  speak('已加载示例图片，迪奥 999 经典正红。请点击开始判断。');
}

// 重置结果区（重新上传时）
function resetJudgmentUI() {
  document.getElementById('result-display').classList.remove('show');
  document.getElementById('btn-replay').style.display = 'none';
  document.getElementById('cache-badge').classList.remove('show');
  document.getElementById('extra-pairing').classList.remove('show');
  document.getElementById('extra-guide').classList.remove('show');
  document.getElementById('saved-toast').style.display = 'none';
  const saveBtn = document.getElementById('btn-save');
  saveBtn.classList.remove('saved');
  saveBtn.querySelector('.fb-text').textContent = '保存产品';
  document.getElementById('btn-pairing').style.display = '';
  document.getElementById('btn-guide').style.display = '';
  currentJudgmentSaved = false;
  cachedLibraryItem = null;
  lastJudgmentResult = null;
}

// 开始判断
function startJudgment() {
  if (!hasUploadedImage) {
    speak('请先上传图片');
    showStatus('请先上传图片');
    vibrate([100, 50, 100, 50, 100]);
    return;
  }

  const btn = document.getElementById('btn-judge');
  btn.disabled = true;
  btn.textContent = '⏳ 正在分析…';
  speak('正在分析图片，请稍候。');
  vibrate([50]);

  // 命中本地美妆库 → 秒出（P6）
  if (cachedLibraryItem) {
    setTimeout(() => {
      const result = cachedLibraryItem.result;
      result._fromCache = true;
      result._prompt = cachedLibraryItem.prompt || getActivePrompt();
      const ta = document.getElementById('custom-prompt');
      if (ta && cachedLibraryItem.prompt) ta.value = cachedLibraryItem.prompt;
      refreshPromptSource();
      displayJudgmentResult(result, cachedLibraryItem.mode || judgeMode);
      btn.disabled = false;
      btn.textContent = '🔍 重新判断';
    }, 450);
    return;
  }

  // 否则调用 DeepSeek 视觉模型（Files API + file_id），失败则本地模拟兜底
  judgeWithFallback(btn, judgeMode);
}

// 调用后端 /api/judge（DeepSeek Vision，真实 AI）
async function judgeViaDeepSeek(dataUrl, mode, prompt) {
  const resp = await fetch('/api/judge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, mode: mode || 'product', prompt: prompt || '' })
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).error || ''; } catch (e) {}
    throw new Error('judge HTTP ' + resp.status + ' ' + detail);
  }
  const data = await resp.json();
  if (data.parseError || !data.judgment) {
    throw new Error('AI 未返回结构化结果');
  }
  return data;
}

// 真实 AI 优先；后端不可达 / 返回异常时回退本地模拟，保证演示永远可用
async function judgeWithFallback(btn, mode) {
  mode = mode || judgeMode;
  const prompt = getActivePrompt();
  try {
    const dataUrl = document.getElementById('thumb').src;
    const result = await judgeViaDeepSeek(dataUrl, mode, prompt);
    result.source = 'deepseek';
    result._prompt = prompt;
    displayJudgmentResult(result, mode);
  } catch (e) {
    console.warn('DeepSeek 调用失败，回退本地模拟：', e);
    showStatus('AI 接口暂不可用，已用本地模拟结果');
    const dataset = (mode === 'person') ? MOCK_RESULTS_PERSON : MOCK_RESULTS_PRODUCT;
    const seed = fingerprintSeed(currentFingerprint || [128, 128, 128]) % dataset.length;
    const result = dataset[seed];
    result.source = 'mock';
    result._prompt = prompt;
    displayJudgmentResult(result, mode);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 重新判断';
  }
}

// 显示判断结果（双模式：看产品 / 看人）
function displayJudgmentResult(result, mode) {
  mode = mode || judgeMode;
  lastJudgmentResult = result;
  lastJudgmentMode = mode;

  const display = document.getElementById('result-display');
  const verdictEl = document.getElementById('verdict');
  const barFill = document.getElementById('bar-fill');
  const barValue = document.getElementById('bar-value');
  const btnReplay = document.getElementById('btn-replay');
  const titleEl = document.getElementById('bc-title-text');

  // 结论
  if (mode === 'person') {
    verdictEl.textContent = result.judgment + ' 🧑';
    verdictEl.className = 'verdict yes';
  } else {
    if (result.judgment === 'yes') {
      verdictEl.textContent = '是 ✅ 适合';
      verdictEl.className = 'verdict yes';
    } else if (result.judgment === 'no') {
      verdictEl.textContent = '否 ❌ 不太适合';
      verdictEl.className = 'verdict no';
    } else {
      // 自定义命题：judgment 可能是任意短语
      verdictEl.textContent = result.judgment;
      verdictEl.className = 'verdict neutral';
    }
  }

  // 置信度（P2）
  const percent = Math.round((result.confidence || 0) * 100);
  barFill.style.width = percent + '%';
  barValue.textContent = percent + '%';

  // 美妆顾问卡片（按模式组装动态行）
  const rows = (mode === 'person')
    ? [
        ['肤质', result.skinType || result.judgment],
        ['脸型', result.faceShape || '—'],
        ['产品推荐', result.productRec || '—'],
        ['使用建议', result.advice || '—']
      ]
    : [
        ['色号名称', result.shadeName],
        ['颜色描述', result.colorDesc, shadeFromColorDesc(result.colorDesc)],
        ['质地描述', result.textureDesc],
        ['肤色匹配', result.matchReason],
        ['使用建议', result.advice]
      ];
  const rowsHtml = rows.map(([label, val, dotColor]) => {
    const dot = dotColor ? `<span class="chip-color" style="background:${dotColor}"></span>` : '';
    return `<div class="beauty-row"><div class="b-label">${label}</div><div class="b-value">${dot}${val || '—'}</div></div>`;
  }).join('');
  titleEl.textContent = (mode === 'person') ? '肤质诊断报告' : '美妆顾问解读';
  document.getElementById('beauty-rows').innerHTML = rowsHtml;

  // 口语化理由（P2 / P5）
  document.getElementById('reason-text').textContent = result.reason;

  // 显示结果区
  display.classList.add('show');
  btnReplay.style.display = 'flex';

  // 缓存徽章
  const badge = document.getElementById('cache-badge');
  if (result._fromCache) {
    badge.textContent = '⚡ 来自我的美妆库 · 秒出结果';
    badge.classList.add('show');
  } else {
    badge.classList.remove('show');
  }

  // 重置延伸按钮 + 拍自己模式隐藏「推荐搭配 / 上妆指引」
  const saveBtn = document.getElementById('btn-save');
  saveBtn.classList.remove('saved');
  saveBtn.querySelector('.fb-text').textContent = (mode === 'person') ? '保存分析' : '保存产品';
  currentJudgmentSaved = false;
  document.getElementById('extra-pairing').classList.remove('show');
  document.getElementById('extra-guide').classList.remove('show');
  document.getElementById('saved-toast').style.display = 'none';
  document.getElementById('btn-pairing').style.display = (mode === 'person') ? 'none' : '';
  document.getElementById('btn-guide').style.display = (mode === 'person') ? 'none' : '';

  // 语音播报（P3）— 引用用户实际提出的判断命题
  const q = result._prompt || getActivePrompt();
  const suitWord = result.judgment === 'yes' ? '适合'
    : (result.judgment === 'no' ? '不太适合' : result.judgment);
  const broadcast = (mode === 'person')
    ? `你问的是：${q}。分析完成：你属于${result.judgment}。${result.skinType}。脸型${result.faceShape}。推荐${result.productRec}。建议：${result.advice}。${result.reason}`
    : `你问的是：${q}。判断结果：${suitWord}，置信度百分之${percent}。色号${result.shadeName}，${result.colorDesc}，${result.textureDesc}。原因：${result.matchReason}。建议：${result.advice}。${result.reason}`;
  setTimeout(() => speak(broadcast), 300);

  // 振动反馈（按模式）
  if (mode === 'person') vibratePerson(result);
  else vibrateJudgment(result);
}

// 拍自己：按肤质类型触发不同振动（跨感官翻译）
function vibratePerson(result) {
  const key = skinCategory(result.judgment);
  vibrate(VIBRATION_BY_SKIN[key] || VIBRATION_BY_SKIN.default);
}

// 由颜色描述推断一个展示色（仅用于色点）
function shadeFromColorDesc(desc) {
  const t = (desc || "");
  if (t.includes('粉')) return '#E8A0A0';
  if (t.includes('橘') || t.includes('橙')) return '#E8853A';
  if (t.includes('棕') || t.includes('砖') || t.includes('番茄')) return '#C0503C';
  return '#C8102E'; // 默认红
}

// 重新播报（P3，按模式 + 引用用户提出的命题）
function replayJudgment() {
  if (!lastJudgmentResult) return;
  const result = lastJudgmentResult;
  const mode = lastJudgmentMode;
  const percent = Math.round((result.confidence || 0) * 100);
  const q = result._prompt || getActivePrompt();
  const suitWord = result.judgment === 'yes' ? '适合'
    : (result.judgment === 'no' ? '不太适合' : result.judgment);
  const broadcast = (mode === 'person')
    ? `你问的是：${q}。分析完成：你属于${result.judgment}。${result.skinType}。脸型${result.faceShape}。推荐${result.productRec}。建议：${result.advice}。${result.reason}`
    : `你问的是：${q}。判断结果：${suitWord}，置信度百分之${percent}。色号${result.shadeName}，${result.colorDesc}，${result.textureDesc}。原因：${result.matchReason}。建议：${result.advice}。${result.reason}`;
  speak(broadcast);
  if (mode === 'person') vibratePerson(result);
  else vibrateJudgment(result);
}

// ==================== P7 全流程延伸 ====================
function saveToLibrary() {
  if (!lastJudgmentResult) {
    showStatus('请先完成一次判断');
    return;
  }
  if (currentJudgmentSaved) {
    showStatus('已经在你的美妆库里啦');
    return;
  }
  const lib = loadLibrary();
  const mode = lastJudgmentMode;
  const name = (mode === 'person')
    ? (lastJudgmentResult.judgment + ' · 肤质分析')
    : (lastJudgmentResult.shadeName);
  const entry = {
    name: name,
    result: lastJudgmentResult,
    mode: mode,
    prompt: lastJudgmentResult._prompt || getActivePrompt(),
    fp: currentFingerprint || [128,128,128],
    savedAt: new Date().toLocaleString('zh-CN')
  };
  // 去重：同指纹 + 同模式不重复存
  const exists = lib.findIndex(it => it.mode === mode && fpDistance(it.fp, entry.fp) < 42);
  if (exists >= 0) lib[exists] = entry;
  else lib.unshift(entry);
  saveLibrary(lib);

  currentJudgmentSaved = true;
  const saveBtn = document.getElementById('btn-save');
  saveBtn.classList.add('saved');
  saveBtn.querySelector('.fb-text').textContent = '✓ 已保存';

  const toast = document.getElementById('saved-toast');
  toast.textContent = '💄 已加入「我的美妆库」，下次同款秒出';
  toast.style.display = 'block';

  speak('已保存到我的美妆库。下次拍到同款，直接秒出结果。');
  vibrate([120, 40, 120]);
}

function showPairing() {
  if (!lastJudgmentResult) { showStatus('请先完成一次判断'); return; }
  const cat = colorCategory(lastJudgmentResult.colorDesc);
  const items = PAIRINGS[cat] || PAIRINGS.red;
  const ul = document.getElementById('pairing-list');
  ul.innerHTML = items.map(t => `<li>${t}</li>`).join('');
  document.getElementById('extra-pairing').classList.add('show');
  speak('推荐搭配：' + items.join('；') + '。');
  vibrate([60, 30, 60]);
}

function showGuide() {
  if (!lastJudgmentResult) { showStatus('请先完成一次判断'); return; }
  const r = lastJudgmentResult;
  const steps = buildGuide(r);
  const ul = document.getElementById('guide-list');
  ul.innerHTML = steps.map(t => `<li>${t}</li>`).join('');
  document.getElementById('extra-guide').classList.add('show');
  speak('上妆指引：' + steps.join('。'));
  vibrate([60, 30, 60, 30, 60]);
}

// 根据质地生成上妆指引
function buildGuide(r) {
  const steps = [];
  steps.push('① 唇部去角质 + 润唇膏打底，让颜色更服帖持久');
  if (r.textureDesc.includes('哑光')) {
    steps.push('② 哑光易显唇纹，先用遮瑕轻盖一层原唇色再上色');
  } else if (r.textureDesc.includes('丝绒')) {
    steps.push('② 丝绒质地顺滑好推，点涂后用指腹晕开即可');
  } else if (r.textureDesc.includes('滋润') || r.textureDesc.includes('水光') || r.textureDesc.includes('镜面')) {
    steps.push('② 滋润/镜面质地直接涂，自带高光玻璃唇感');
  } else {
    steps.push('② 取适量点涂唇部中央，自然晕开');
  }
  steps.push('③ ' + r.advice);
  steps.push('④ 想更持久，纸巾轻压后再薄薄叠一层');
  return steps;
}

// ==================== P6 美妆库（localStorage） ====================
function loadLibrary() {
  try {
    return JSON.parse(localStorage.getItem(LIB_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveLibrary(list) {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(list.slice(0, 50)));
  } catch (e) {
    showStatus('保存失败：存储空间不足');
  }
}

function findInLibrary(fp, mode) {
  const lib = loadLibrary();
  let best = null, minD = 42; // 阈值：颜色足够接近才算同款；且需同模式
  for (const it of lib) {
    if (mode && it.mode && it.mode !== mode) continue;
    const d = fpDistance(fp, it.fp);
    if (d < minD) { minD = d; best = it; }
  }
  return best;
}

function renderLibrary() {
  const list = document.getElementById('library-list');
  const empty = document.getElementById('library-empty');
  const count = document.getElementById('library-count');
  const lib = loadLibrary();

  if (lib.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    count.textContent = '';
    return;
  }
  empty.style.display = 'none';
  count.textContent = `共 ${lib.length} 件 · 点击任意一项重温结果`;
  list.innerHTML = lib.map((item, i) => {
    const isPerson = item.mode === 'person';
    const dot = isPerson ? '#7FB3A3' : shadeFromColorDesc(item.result.colorDesc);
    const meta = isPerson
      ? `${item.result.judgment} · 脸型${item.result.faceShape || '—'}`
      : `${item.result.colorDesc || ''} · ${item.result.textureDesc || ''} · ${item.result.judgment === 'yes' ? '适合黄皮' : '不太适合'}`;
    const tag = isPerson ? '🧑 看人' : '💄 看产品';
    return `
    <div class="library-card" onclick="loadLibraryItem(${i})">
      <div class="top-row">
        <div class="dot" style="background:${dot}"></div>
        <div class="name">${item.name}</div>
      </div>
      <div class="meta">${meta}</div>
      <div class="time">${tag} · 保存于 ${item.savedAt}</div>
    </div>`;
  }).join('');
}

function loadLibraryItem(i) {
  const lib = loadLibrary();
  const item = lib[i];
  if (!item) return;
  // 回到主页并展示该结果
  goTo('home');
  // 同步模式（看产品 / 看人）
  if (item.mode) setJudgeMode(item.mode);
  // 还原当时保存的判断命题
  if (item.prompt) {
    const ta = document.getElementById('custom-prompt');
    if (ta) ta.value = item.prompt;
    refreshPromptSource();
  }
  // 确保上传区有状态
  hasUploadedImage = true;
  currentFingerprint = item.fp;
  lastJudgmentResult = item.result;
  item.result._prompt = item.prompt || item.result._prompt;
  displayJudgmentResult(item.result, item.mode || 'product');
  document.getElementById('home').scrollIntoView({ behavior: 'smooth' });
  speak('已为你打开美妆库中的：' + item.name);
}

function clearLibrary() {
  if (!confirm('确定要清空「我的美妆库」吗？此操作不可恢复。')) return;
  localStorage.removeItem(LIB_KEY);
  renderLibrary();
  speak('美妆库已清空。');
}

// ==================== 初始化 ====================
window.onload = function() {
  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
  }
  initSpeechRecognition();
  initPrompt();
  bindFileInput();

  setMode('voice');

  setTimeout(() => {
    speak('欢迎使用美妆助手。你现在处于语音模式，全程有语音引导。页面下方可以上传口红照片，我会判断它是否适合黄皮肤，还能语音播报和振动提醒。');
  }, 800);
};

window.onbeforeunload = function() {
  stopCamera();
  if (window.speechSynthesis) window.speechSynthesis.cancel();
};
