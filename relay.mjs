// B 站请求中转服务（零依赖 Node，可直接跑在阿里云 FC / 腾讯云 Web 函数 / VPS / 本机）
//
// 作用：Cloudflare 的出口 IP 被 B 站（阿里云 WAF）整段拉黑，Worker 直连必 412。
// 这个中转跑在国内（或用你自己的机器），出口 IP 干净，负责替 Worker 去请求 B 站。
// 视频字节流不经过这里 —— 只有"解析类"请求（API 和页面 HTML）走中转。
//
// 启动：  node relay.mjs
// 环境变量：
//   PORT              监听端口，默认 9000（阿里云 FC / 腾讯云 Web 函数要求 9000）
//   RELAY_TOKEN       鉴权口令，必须和 Worker 里的 RELAY_TOKEN 一致（强烈建议设置）
//   RELAY_ALLOW       额外的域名白名单，逗号分隔，如 douyin.com,kuaishou.com
//   RELAY_ALLOW_PRIVATE=1  允许转发到内网地址（仅本地调试用，生产不要开）

import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT || 9000);
const TOKEN = process.env.RELAY_TOKEN || '';
const ALLOW_PRIVATE = process.env.RELAY_ALLOW_PRIVATE === '1';

// 默认白名单：B 站系 + 常见视频站。只有解析类请求会走这里。
const DEFAULT_ALLOW = [
  /^[\w.-]*bilibili\.com$/,
  /^[\w.-]*b23\.tv$/,
  /^[\w.-]*hdslb\.com$/,
  /^[\w.-]*bilivideo\.com$/,
  /^[\w.-]*douyin\.com$/,
  /^[\w.-]*iesdouyin\.com$/,
  /^[\w.-]*kuaishou\.com$/,
  /^[\w.-]*gifshow\.com$/,
];

const EXTRA_ALLOW = (process.env.RELAY_ALLOW || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => new RegExp(s, 'i'));

const ALLOW = [...DEFAULT_ALLOW, ...EXTRA_ALLOW];

function hostAllowed(host) {
  const h = String(host).toLowerCase();
  return ALLOW.some((re) => re.test(h));
}

function isPrivate(host) {
  const h = String(host).toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '127.0.0.1' || h === '0.0.0.0') return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleRelay(req, res) {
  if (TOKEN) {
    const got = req.headers['x-relay-token'] || '';
    if (got !== TOKEN) return json(res, 401, { error: 'token 不对' });
  }

  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' });
  }

  const target = payload.url;
  if (typeof target !== 'string') return json(res, 400, { error: '缺少 url' });

  let u;
  try {
    u = new URL(target);
  } catch {
    return json(res, 400, { error: 'url 不合法' });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return json(res, 400, { error: '只支持 http/https' });
  }
  if (!hostAllowed(u.hostname)) {
    return json(res, 403, { error: `域名不在白名单：${u.hostname}`, hint: '如需放行，启动时设置 RELAY_ALLOW=该域名' });
  }
  if (!ALLOW_PRIVATE && isPrivate(u.hostname)) {
    return json(res, 403, { error: '禁止转发到内网地址' });
  }

  const upHeaders = {};
  for (const [k, v] of Object.entries(payload.headers || {})) {
    if (typeof v !== 'string') continue;
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'content-length' || lk === 'connection') continue;
    upHeaders[k] = v;
  }
  // 中转自己补一个稳定的 UA，避免上游把它当可疑客户端
  if (!upHeaders['User-Agent'] && !upHeaders['user-agent']) {
    upHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let upstream;
  try {
    upstream = await fetch(u.href, {
      method: (payload.method || 'GET').toUpperCase(),
      headers: upHeaders,
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return json(res, 502, { error: '请求上游失败', detail: String(e && e.message) });
  }
  clearTimeout(timer);

  const out = {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-type,content-length',
    'cache-control': 'no-store',
    'x-relay-upstream-status': String(upstream.status),
  };
  const pass = ['content-type', 'content-length', 'content-range', 'etag', 'last-modified'];
  for (const k of pass) {
    const v = upstream.headers.get(k);
    if (v) out[k] = v;
  }
  // 去掉压缩，避免双重编码问题
  delete out['content-encoding'];

  res.writeHead(upstream.status, out);
  if (!upstream.body) { res.end(); return; }
  try {
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-relay-token',
    });
    res.end();
    return;
  }

  if (url.pathname === '/' && req.method === 'GET') {
    return json(res, 200, {
      service: 'bili-relay',
      ok: true,
      tokenSet: !!TOKEN,
      privateAllowed: ALLOW_PRIVATE,
      usage: 'POST /  body: {"url":"...","method":"GET","headers":{...}}  header: x-relay-token',
    });
  }

  if (url.pathname === '/' && req.method === 'POST') {
    try {
      return await handleRelay(req, res);
    } catch (e) {
      return json(res, 500, { error: '中转内部错误', detail: String(e && e.message) });
    }
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`\n  中转服务已启动：http://0.0.0.0:${PORT}`);
  console.log(`  鉴权口令：${TOKEN ? '已设置' : '未设置（建议设 RELAY_TOKEN）'}`);
  console.log(`  内网转发：${ALLOW_PRIVATE ? '允许（调试模式）' : '禁止'}\n`);
});
