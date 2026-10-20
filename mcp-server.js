#!/usr/bin/env node
'use strict';
// 分你一只耳机 · MCP Server
// 支持两种传输模式：
//   1. stdio（Claude Desktop / Claude Code）
//   2. SSE 远程（Claude.ai 手机端 / 网页端，通过 connector 接入）
//
// 用法：
//   stdio 模式：  node mcp-server.js
//   SSE 模式：    node mcp-server.js --sse          （独立跑，默认端口 3001）
//   集成模式：    在 example-server.js 里 require 并挂到 express app 上
//
// 环境变量：
//   ONE_EARBUD_URL   — one-earbud 服务地址（stdio 模式用，默认 http://localhost:8787）
//   ONE_EARBUD_TOKEN — 访问口令（和 .env 里的一致）
//   MCP_PORT         — SSE 独立模式端口（默认 3001）

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const readline = require('readline');

const BASE = (process.env.ONE_EARBUD_URL || 'http://localhost:8787').replace(/\/+$/, '');
const TOKEN = process.env.ONE_EARBUD_TOKEN || '';

// ── HTTP 请求封装（调用 one-earbud 后端）────────────────────────────────
function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body != null ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {})
      },
      timeout: 15000
    };
    const req = mod.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok === false) {
            const err = new Error(json.message || json.error || 'request failed');
            err.code = json.error || 'UNKNOWN';
            reject(err);
          } else resolve(json);
        } catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── MCP 工具定义 ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'now_playing',
    description: '看景桦现在在听什么歌、唱到哪一句。没在听就返回 listening:false。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'lyrics',
    description: '读一首歌的完整歌词（带翻译）。每句有 index，之后 share 附歌词行号要用。',
    inputSchema: {
      type: 'object', required: ['songId'],
      properties: { songId: { type: 'string', description: '网易云歌曲 id（从 search 或 now_playing 拿）' } },
      additionalProperties: false
    }
  },
  {
    name: 'search',
    description: '搜歌：输入关键词（歌名、歌手都行），返回最多 10 首。',
    inputSchema: {
      type: 'object', required: ['query'],
      properties: { query: { type: 'string', description: '搜索关键词，1–80 字' } },
      additionalProperties: false
    }
  },
  {
    name: 'queue',
    description: '看景桦的播放列表：当前放到哪首、播放模式、每首谁加的。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'share',
    description: '把一首歌作为卡片发给景桦（不播放）。可以附一句话 note、附几句歌词 lineIndexes（先用 lyrics 看行号）。',
    inputSchema: {
      type: 'object', required: ['songId'],
      properties: {
        songId: { type: 'string', description: '网易云歌曲 id' },
        note: { type: 'string', description: '附在卡片上的一句话（≤300字）' },
        lineIndexes: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 8, description: '歌词行号（lyrics 返回的 index），最多 8 句' },
        requestId: { type: 'string', description: '幂等键（8–80字符），重试复用同一个值避免重复' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'play_next',
    description: '把一首歌排在景桦正在听的那首后面（不打断，可附 note）。',
    inputSchema: {
      type: 'object', required: ['songId'],
      properties: {
        songId: { type: 'string', description: '网易云歌曲 id' },
        note: { type: 'string', description: '列表里这首下面那行小字（≤120字）' },
        requestId: { type: 'string', description: '幂等键' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'queue_add',
    description: '把一首歌加到景桦的播放列表最后（可附 note）。',
    inputSchema: {
      type: 'object', required: ['songId'],
      properties: {
        songId: { type: 'string', description: '网易云歌曲 id' },
        note: { type: 'string', description: '列表里这首下面那行小字（≤120字）' },
        requestId: { type: 'string', description: '幂等键' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'play_now',
    description: '直接给景桦放一首歌：插进列表成为当前曲、发一张卡。景桦在听歌就立刻切过去；停着时她点一下才响（苹果不许网页自己出声）。可附 note。',
    inputSchema: {
      type: 'object', required: ['songId'],
      properties: {
        songId: { type: 'string', description: '网易云歌曲 id' },
        note: { type: 'string', description: '卡片上和歌词页里显示的一句话（≤300字）' },
        requestId: { type: 'string', description: '幂等键' }
      },
      additionalProperties: false
    }
  }
];

// ── 工具执行 ────────────────────────────────────────────────────────────
// 两种模式：
//   A) 远程模式（callToolRemote）：走 HTTP 调 /api/music/tool
//   B) 直连模式（callToolDirect）：直接调 authority handler（集成进 example-server 时用）
let toolHandler = null; // 直连时由 mountMcp 设置

async function callToolRemote(name, args) {
  args = args || {};
  const body = { action: name, ...args };
  return apiRequest('POST', '/api/music/tool', body);
}

async function callTool(name, args) {
  if (toolHandler) {
    // 直连模式
    return toolHandler({ action: name, ...(args || {}) });
  }
  // 远程模式
  return callToolRemote(name, args);
}

// ── MCP 协议处理（传输无关）──────────────────────────────────────────────
const SERVER_INFO = { name: 'one-earbud', version: '0.1.0' };
const CAPABILITIES = { tools: {} };

async function handleJsonRpc(msg) {
  const { id, method, params } = msg;

  // 通知类消息不需要回应
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;

  try {
    let result;
    switch (method) {
      case 'initialize':
        result = { protocolVersion: '2024-11-05', serverInfo: SERVER_INFO, capabilities: CAPABILITIES };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const toolName = params && params.name;
        const toolArgs = params && params.arguments;
        try {
          const out = await callTool(toolName, toolArgs);
          result = { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        } catch (e) {
          result = {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.code || 'ERROR', message: e.message }) }],
            isError: true
          };
        }
        break;
      }
      default:
        if (id != null) return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
        return null;
    }
    if (id != null) return { jsonrpc: '2.0', id, result };
    return null;
  } catch (e) {
    if (id != null) return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 传输层 A：stdio（Claude Desktop / Claude Code）
// ═══════════════════════════════════════════════════════════════════════
function startStdio() {
  function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async line => {
    if (!line.trim()) return;
    try {
      const resp = await handleJsonRpc(JSON.parse(line));
      if (resp) send(resp);
    } catch (e) { process.stderr.write('[one-earbud-mcp] parse error: ' + e.message + '\n'); }
  });
  rl.on('close', () => process.exit(0));
  process.stderr.write('[one-earbud-mcp] stdio mode, connecting to ' + BASE + '\n');
}

// ═══════════════════════════════════════════════════════════════════════
// 传输层 B：SSE 远程（Claude.ai 手机端 / 网页端）
// 协议：MCP over SSE
//   GET  /sse       → SSE 流，先发 endpoint 事件告诉客户端 POST 地址
//   POST /message   → 客户端发 JSON-RPC 请求，回应通过 SSE 流推回
// ═══════════════════════════════════════════════════════════════════════

// SSE 会话管理
const sessions = new Map(); // sessionId -> { res, lastActivity }
const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 分钟没活动就清

function cleanSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > SESSION_TIMEOUT) {
      try { s.res.end(); } catch (_) {}
      sessions.delete(id);
    }
  }
}
setInterval(cleanSessions, 60000).unref();

function sseWrite(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n');
}

function handleSseRoutes(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /sse — 建立 SSE 连接
  if (req.method === 'GET' && path === '/sse') {
    const sessionId = crypto.randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    sessions.set(sessionId, { res, lastActivity: Date.now() });

    // 告诉客户端往哪里 POST
    sseWrite(res, 'endpoint', '/message?sessionId=' + sessionId);

    // 心跳
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); }
    }, 30000);

    req.on('close', () => {
      clearInterval(hb);
      sessions.delete(sessionId);
    });
    return;
  }

  // POST /message — 接收 JSON-RPC 请求
  if (req.method === 'POST' && path === '/message') {
    const sessionId = url.searchParams.get('sessionId');
    const session = sessionId && sessions.get(sessionId);
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired session. Reconnect to /sse.' }));
      return;
    }
    session.lastActivity = Date.now();

    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const msg = JSON.parse(body);
        // 先回 202 告诉客户端收到了
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        // 处理请求，通过 SSE 推回
        const resp = await handleJsonRpc(msg);
        if (resp && session.res && !session.res.writableEnded) {
          sseWrite(session.res, 'message', resp);
        }
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      }
    });
    return;
  }

  // 其他路径：404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found. Use GET /sse to connect.' }));
}

function startSseStandalone() {
  const port = Number(process.env.MCP_PORT) || 3001;
  const server = http.createServer(handleSseRoutes);
  server.listen(port, () => {
    console.log('[one-earbud-mcp] SSE mode on http://localhost:' + port + '/sse');
    console.log('[one-earbud-mcp] connecting to backend at ' + BASE);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 集成模式：挂到已有的 express app 上（和 one-earbud 后端同进程）
// ═══════════════════════════════════════════════════════════════════════
function mountMcp(app, authority) {
  // 直连 authority：不走 HTTP，直接调 tool-contract handler
  const { createTaMusicTool } = require('./server/agent/tool-contract');
  const tool = createTaMusicTool({ authority });
  toolHandler = async (input) => tool.handler(input);

  // 把 SSE 路由挂到 /mcp 前缀下
  app.use('/mcp', (req, res) => {
    // 重写 url 去掉 /mcp 前缀
    const orig = req.url;
    req.url = req.url.replace(/^\/mcp/, '') || '/';
    handleSseRoutes(req, res);
    req.url = orig;
  });

  console.log('[one-earbud-mcp] mounted at /mcp (SSE: GET /mcp/sse, POST /mcp/message)');
}

// ═══════════════════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════════════════
if (require.main === module) {
  if (process.argv.includes('--sse')) {
    startSseStandalone();
  } else {
    startStdio();
  }
}

module.exports = { mountMcp, handleSseRoutes, TOOLS };
