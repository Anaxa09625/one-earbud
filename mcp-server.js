#!/usr/bin/env node
'use strict';
// 分你一只耳机 · MCP Server
// 支持三种传输模式：
//   1. stdio（Claude Desktop / Claude Code）
//   2. Streamable HTTP（Claude.ai 手机端 / 网页端，通过 connector 接入）
//   3. 集成模式：挂到 express app 上（和 one-earbud 后端同进程）
//
// 用法：
//   stdio 模式：  node mcp-server.js
//   HTTP 模式：   node mcp-server.js --http         （独立跑，默认端口 3001）
//   集成模式：    在 example-server.js 里 require 并挂到 express app 上
//
// 环境变量：
//   ONE_EARBUD_URL   — one-earbud 服务地址（stdio 模式用，默认 http://localhost:8787）
//   ONE_EARBUD_TOKEN — 访问口令（和 .env 里的一致）
//   MCP_PORT         — HTTP 独立模式端口（默认 3001）

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
let toolHandler = null; // 直连时由 mountMcp 设置

async function callToolRemote(name, args) {
  args = args || {};
  const body = { action: name, ...args };
  return apiRequest('POST', '/api/music/tool', body);
}

async function callTool(name, args) {
  if (toolHandler) return toolHandler({ action: name, ...(args || {}) });
  return callToolRemote(name, args);
}

// ── MCP 协议处理（传输无关）──────────────────────────────────────────────
const SERVER_INFO = { name: 'one-earbud', version: '0.2.0' };
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
// 传输层 B：Streamable HTTP（Claude.ai 连接器用的新版协议）
// 协议：
//   POST /mcp  → 客户端发 JSON-RPC，服务器回 JSON 或 SSE 流
//   GET  /mcp  → 可选的 SSE 流（server→client 推送）
//   DELETE /mcp → 关闭会话
//   会话 ID 通过 Mcp-Session-Id 头传递
// ═══════════════════════════════════════════════════════════════════════

const streamableSessions = new Map(); // sessionId -> { lastActivity, sseRes? }
const STREAMABLE_TIMEOUT = 10 * 60 * 1000;

function cleanStreamableSessions() {
  const now = Date.now();
  for (const [id, s] of streamableSessions) {
    if (now - s.lastActivity > STREAMABLE_TIMEOUT) {
      if (s.sseRes) try { s.sseRes.end(); } catch (_) {}
      streamableSessions.delete(id);
    }
  }
}
setInterval(cleanStreamableSessions, 60000).unref();

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function handleStreamableHttp(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── POST: 客户端发 JSON-RPC 请求 ──
  if (req.method === 'POST') {
    // 读取请求体：express.json() 可能已经解析过了（req.body 存在），
    // 也可能是独立模式需要从 stream 读。
    const processMsg = async (msg) => {
      if (!msg || typeof msg !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const isInit = msg.method === 'initialize';
      const isNotification = (msg.method && msg.method.startsWith('notifications/'));

      const sessionId = req.headers['mcp-session-id'];
      if (!isInit && !isNotification && sessionId) {
        const session = streamableSessions.get(sessionId);
        if (session) session.lastActivity = Date.now();
      }

      if (isNotification) {
        await handleJsonRpc(msg);
        res.writeHead(202);
        res.end();
        return;
      }

      const resp = await handleJsonRpc(msg);

      if (isInit && resp) {
        const newSessionId = crypto.randomUUID();
        streamableSessions.set(newSessionId, { lastActivity: Date.now() });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': newSessionId
        });
        res.end(JSON.stringify(resp));
        return;
      }

      if (resp) {
        const headers = { 'Content-Type': 'application/json' };
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        res.writeHead(200, headers);
        res.end(JSON.stringify(resp));
      } else {
        res.writeHead(202);
        res.end();
      }
    };

    // express 已经解析过 body 了？直接用
    if (req.body && typeof req.body === 'object') {
      processMsg(req.body);
      return;
    }

    // 独立模式：从 stream 读
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch (_) { msg = null; }
      processMsg(msg);
    });
    return;
  }

  // ── GET: 可选的 SSE 流（server→client 推送通道）──
  // 没有 session 时返回服务器信息（给 Claude.ai 探测用）
  if (req.method === 'GET') {
    const sessionId = req.headers['mcp-session-id'];
    const session = sessionId && streamableSessions.get(sessionId);
    if (!session) {
      // 没有 session — 可能是 Claude.ai 的连通性探测，返回友好信息
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'one-earbud', version: '0.2.0', status: 'ok', transport: 'streamable-http' }));
      return;
    }
    session.lastActivity = Date.now();

    // 建立 SSE 流
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Mcp-Session-Id': sessionId
    });
    session.sseRes = res;

    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); }
    }, 30000);

    req.on('close', () => {
      clearInterval(hb);
      if (session.sseRes === res) session.sseRes = null;
    });
    return;
  }

  // ── DELETE: 关闭会话 ──
  if (req.method === 'DELETE') {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId) {
      const session = streamableSessions.get(sessionId);
      if (session && session.sseRes) try { session.sseRes.end(); } catch (_) {}
      streamableSessions.delete(sessionId);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 其他方法
  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed. Use POST, GET, or DELETE.' }));
}

function startHttpStandalone() {
  const port = Number(process.env.MCP_PORT) || 3001;
  const server = http.createServer(handleStreamableHttp);
  server.listen(port, () => {
    console.log('[one-earbud-mcp] Streamable HTTP mode on http://localhost:' + port + '/');
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

  // Streamable HTTP 端点挂到 /mcp
  app.use('/mcp', (req, res) => {
    handleStreamableHttp(req, res);
  });

  console.log('[one-earbud-mcp] mounted at /mcp (Streamable HTTP)');
}

// ═══════════════════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════════════════
if (require.main === module) {
  if (process.argv.includes('--sse') || process.argv.includes('--http')) {
    startHttpStandalone();
  } else {
    startStdio();
  }
}

module.exports = { mountMcp, handleStreamableHttp, TOOLS };
