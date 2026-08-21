/* ===================================================================
 * server.js — 美妆无障碍助手 · 后端服务
 *
 * 职责：
 *   1) 托管前端静态文件（index.html / css / js）
 *   2) POST /api/judge：接收前端传来的图片（dataURL）
 *        → 通过 DeepSeek Files API 上传，拿到 file_id
 *        → 调用 deepseek-v4-flash-vision-exp 视觉模型
 *        → 返回结构化的美妆判断 JSON
 *
 * API Key 仅存在于服务端环境变量（.env），绝不暴露给浏览器。
 * 图片采用「Files API」方式（用户指定的第三种方式）。
 * ================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- 极简 .env 加载（无第三方依赖） ----------
function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    txt.split('\n').forEach(line => {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    });
  } catch (e) {
    console.warn('未找到 .env 文件，使用系统环境变量。');
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE = 'https://api.deepseek.com';
const MODEL = 'deepseek-v4-flash-vision-exp';

// 让视觉模型以「美妆顾问 / 皮肤分析师」身份输出结构化 JSON
// 按模式返回不同提示词：product=看产品，person=看人
// userPrompt（可选）：用户自定义的「判断命题」，会作为核心问题嵌入提示词
function buildPrompt(mode, userPrompt) {
  const q = (userPrompt && String(userPrompt).trim()) ? String(userPrompt).trim() : '';
  if (mode === 'person') {
    const head = q
      ? `你是一位专业的美妆顾问与皮肤分析师，正在帮助一位视障 / 色觉障碍用户了解自己的皮肤。用户的具体需求是：「${q}」。请看这张人脸照片，围绕该需求分析她的肤质、肤色与脸型，并给出化妆品推荐。`
      : `你是一位专业的美妆顾问与皮肤分析师，正在帮助一位视障 / 色觉障碍用户了解自己的皮肤。请看这张人脸照片，分析她的肤质、肤色与脸型，并给出化妆品推荐。`;
    return `${head}

请只返回一个 JSON 对象，不要包含任何额外文字、解释或 markdown 代码块。字段如下：
{
  "judgment": "对你所回答问题的简短结论，例如 混油皮 / 干性皮肤 / 你适合暖调彩妆",
  "confidence": 0 到 1 之间的小数，表示你判断的置信度，
  "skinType": "肤质详细分析，口语化，例如 T区偏油、两颊偏干的混合性皮肤",
  "faceShape": "脸型判断，例如 鹅蛋脸 / 圆脸 / 方脸 / 瓜子脸",
  "productRec": "产品推荐，例如 控油型粉底液搭配保湿妆前乳，局部散粉定妆",
  "advice": "使用建议，例如 分区护理，T区控油两颊保湿",
  "reason": "一句给用户的口语化综合建议，要像美妆顾问一样说话"
}
请确保所有中文文案专业、可理解，面向全肤色人群。`;
  }
  // 默认：看产品
  const head = q
    ? `你是一位专业的美妆顾问，正在帮助一位视障 / 色觉障碍用户判断化妆品。用户的具体需求是：「${q}」。请看这张图片，围绕该需求给出专业判断。`
    : `你是一位专业的美妆顾问，正在帮助一位视障 / 色觉障碍用户判断口红颜色。请看这张图片，判断它的颜色是否适合亚洲暖黄皮。`;
  return `${head}

请只返回一个 JSON 对象，不要包含任何额外文字、解释或 markdown 代码块。字段如下：
{
  "judgment": "若用户问的是「是否适合 / 显白」，请填 yes 或 no（yes=适合，no=不太适合）；否则用一句简短结论（例如 偏暖调）",
  "confidence": 0 到 1 之间的小数，表示你判断的置信度，
  "shadeName": "色号名称，例如 兰蔻#132 或 迪奥#999",
  "colorDesc": "颜色描述，例如 蓝调正红",
  "textureDesc": "质地描述，例如 哑光质地",
  "matchReason": "与用户问题相关的分析，口语化，例如 蓝调可以中和黄色调",
  "advice": "使用建议，例如 薄涂日常，厚涂气场",
  "reason": "一句给用户的口语化综合判断理由，要像美妆顾问一样说话"
}
请确保所有中文文案符合美妆垂直语义，色号 / 颜色 / 质地 / 分析 / 使用建议 都要具体、专业、可理解。`;
}

// ---------- 工具函数 ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function extractJson(text) {
  try {
    let s = (text || '').trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end >= 0) s = s.slice(start, end + 1);
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

// ---------- /api/judge 核心逻辑 ----------
async function handleJudge(req, res) {
  if (!API_KEY) {
    return sendJSON(res, 500, { error: '服务端未配置 DEEPSEEK_API_KEY，请检查 .env' });
  }

  let body = '';
  let aborted = false;
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 30 * 1024 * 1024) { // 30MB 上限
      aborted = true;
      req.destroy();
    }
  });

  req.on('end', async () => {
    if (aborted) return sendJSON(res, 413, { error: '图片过大' });
    let image, mode, prompt;
    try {
      const parsedBody = JSON.parse(body);
      image = parsedBody.image;
      mode = parsedBody.mode === 'person' ? 'person' : 'product'; // 默认看产品
      prompt = parsedBody.prompt; // 可选：用户自定义判断命题
    } catch (e) {
      return sendJSON(res, 400, { error: '请求体不是合法 JSON' });
    }
    if (!image || typeof image !== 'string' || !image.startsWith('data:')) {
      return sendJSON(res, 400, { error: '缺少合法的 image(dataURL)' });
    }

    try {
      const meta = image.slice(0, image.indexOf(','));
      const mime = (meta.match(/data:(.*?);/) || [])[1] || 'image/png';
      const b64 = image.slice(image.indexOf(',') + 1);
      const buf = Buffer.from(b64, 'base64');

      // 仅支持 JPEG/PNG/GIF/WebP
      const okMime = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!okMime.includes(mime)) {
        return sendJSON(res, 415, {
          error: 'DeepSeek 仅支持 JPEG/PNG/GIF/WebP，当前为 ' + mime,
          hint: '请上传真实口红照片（手机拍照/相册）'
        });
      }

      const ext = mime.split('/')[1] || 'png';

      // --- 步骤 1：Files API 上传，取得 file_id ---
      const blob = new Blob([buf], { type: mime });
      const fd = new FormData();
      fd.append('file', blob, `beauty.${ext}`);
      fd.append('purpose', 'user_data');
      fd.append('expires_after[anchor]', 'created_at');
      fd.append('expires_after[seconds]', '3600'); // 1 小时后自动清理

      const up = await fetch(`${DEEPSEEK_BASE}/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}` },
        body: fd
      });
      if (!up.ok) {
        const detail = await up.text();
        return sendJSON(res, 502, { error: 'Files API 上传失败', status: up.status, detail });
      }
      const upJson = await up.json();
      const fileId = upJson.id;
      if (!fileId) {
        return sendJSON(res, 502, { error: 'Files API 未返回 file_id', upJson });
      }

      // --- 步骤 2：调用视觉模型（file_id 引用图片） ---
      const chatRes = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: buildPrompt(mode, prompt) },
                { type: 'file', file_id: fileId }
              ]
            }
          ],
          temperature: 0.3
        })
      });
      if (!chatRes.ok) {
        const detail = await chatRes.text();
        return sendJSON(res, 502, { error: '视觉模型调用失败', status: chatRes.status, detail });
      }
      const chatJson = await chatRes.json();
      const content = chatJson.choices && chatJson.choices[0] && chatJson.choices[0].message
        ? chatJson.choices[0].message.content
        : '';
      const parsed = extractJson(content);

      if (!parsed || !parsed.judgment) {
        // 模型未按要求返回 JSON：原样回传，前端可降级
        return sendJSON(res, 200, { parseError: true, raw: content });
      }
      // 规范化置信度
      if (typeof parsed.confidence === 'string') parsed.confidence = parseFloat(parsed.confidence);
      if (typeof parsed.confidence !== 'number' || isNaN(parsed.confidence)) parsed.confidence = 0.8;

      sendJSON(res, 200, parsed);
    } catch (e) {
      sendJSON(res, 500, { error: '服务端异常', detail: String(e && e.message || e) });
    }
  });
}

// ---------- 静态文件服务 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // 防目录穿越
  const safePath = path.normalize(path.join(__dirname, urlPath));
  if (!safePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- 路由 ----------
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/judge') {
    return handleJudge(req, res);
  }
  if (req.method === 'GET' && req.url === '/api/health') {
    return sendJSON(res, 200, { ok: true, model: MODEL, hasKey: !!API_KEY });
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }
  res.writeHead(405); res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`✅ 美妆助手后端已启动: http://localhost:${PORT}`);
  console.log(`   模型: ${MODEL}`);
  console.log(`   API Key: ${API_KEY ? '已加载(' + API_KEY.slice(0, 6) + '…)' : '未配置 ❌'}`);
});
