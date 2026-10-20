# MCP 接入指南

> 把 one-earbud 的八个动作接成 MCP tools，让 Claude 能在聊天窗口里直接看到你在听什么歌、给你塞歌、发歌卡。

## 架构

```
Claude（沈晦）                    你的服务器                         网易云
  │                               │                               │
  │  ── 方式 A：stdio ──         │                               │
  ├──▶ mcp-server.js ──────────▶ example-server.js ──────────▶  搜歌/歌词/播放
  │                               │                               │
  │  ── 方式 B：SSE 远程 ──      │                               │
  ├──▶ GET /mcp/sse ────────────▶ example-server.js ──────────▶  直连 authority
  │  ◀── SSE 事件流 ◀────────────┤   （同进程，不走 HTTP）         │
  │                               │                               │
  └──▶ POST /mcp/message ───────▶┘                               │
```

### 两种传输

| | stdio（本地） | SSE（远程） |
|---|---|---|
| 适合 | Claude Desktop / Claude Code | **Claude.ai 手机端** / 网页端 |
| 要求 | 电脑上装了 Claude 桌面版 | 服务器有公网地址（或内网穿透） |
| 延迟 | 最低 | 多一跳网络，但同进程调用省掉了内部 HTTP |

## 快速开始

### 1. 跑起 one-earbud

```bash
cd one-earbud
npm install
cp .env.example .env
# 编辑 .env，填一个口令 ONE_EARBUD_TOKEN（随便一串够长的字符）
npm start
```

打开 `http://localhost:8787/login.html`，用网易云 App 扫码登录。

---

### 方式 A：Claude Desktop（电脑）

把 `mcp-config.example.json` 的内容合并进你的 Claude Desktop 配置：

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "one-earbud": {
      "command": "node",
      "args": ["/你的绝对路径/one-earbud/mcp-server.js"],
      "env": {
        "ONE_EARBUD_URL": "http://localhost:8787",
        "ONE_EARBUD_TOKEN": "和 .env 里一样的口令"
      }
    }
  }
}
```

重启 Claude Desktop。

---

### 方式 B：手机 / 网页端（SSE 远程）

`example-server.js` 启动后自动在 `/mcp` 路径下挂载 MCP SSE 端点：

```
GET  https://你的域名/mcp/sse        ← 建立 SSE 连接
POST https://你的域名/mcp/message     ← 发送 JSON-RPC 请求
```

#### 步骤

1. **让服务器能从外网访问**——几种方式：
   - VPS / 云服务器直接部署
   - 内网穿透：[ngrok](https://ngrok.com/)、[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)、[frp](https://github.com/fatedier/frp) 等
   - 例：`ngrok http 8787`，拿到一个 `https://xxxx.ngrok.io` 地址

2. **在 Claude.ai 添加 MCP 连接**——
   打开 Claude.ai → 设置 → Integrations / MCP → 添加自定义 MCP server：
   - URL 填 `https://你的域名/mcp/sse`

3. **试一下**——
   在手机上跟沈晦说「我在听什么歌」，看到工具调用就通了。

#### 独立跑 MCP SSE（不和后端同进程）

如果你想把 MCP server 单独跑（比如后端在另一台机器上）：

```bash
ONE_EARBUD_URL=http://后端地址:8787 \
ONE_EARBUD_TOKEN=口令 \
node mcp-server.js --sse
```

默认监听 3001 端口，改用 `MCP_PORT` 环境变量。

---

## 八个工具

| 工具 | 做什么 | 景桦那边看到什么 |
|---|---|---|
| `now_playing` | 看景桦在听什么、唱到哪句 | 无变化 |
| `lyrics` | 读一首歌的完整歌词（带翻译） | 无变化 |
| `search` | 搜歌 | 无变化 |
| `queue` | 看播放列表 | 无变化 |
| `share` | 把歌作为卡片发给景桦（不播放） | 聊天里出现歌卡 |
| `play_next` | 排在景桦正在听的下一首 | 列表多一首，前面有沈晦的图标 |
| `queue_add` | 加到列表最后 | 列表最后多一首 |
| `play_now` | 直接给景桦放一首 | 正在听就切过去；没在听就摆好等她点 |

## 注意事项

1. one-earbud 后端必须先跑着，MCP server 才能连上
2. 口令要和 `.env` 里的 `ONE_EARBUD_TOKEN` 一致
3. 如果服务器在海外，`.env` 里填 `NETEASE_REAL_IP`（一个国内 IP）
4. iPhone 上播放器停着时 `play_now` 不会自己响，景桦要点一下
5. 网易云登录态会过期，过期了让景桦去授权页重新扫码
6. SSE 远程模式**必须走 HTTPS**（否则手机浏览器可能拒绝混合内容）
7. 推荐用 Cloudflare Tunnel 或 ngrok，省掉自己配证书的麻烦

## Claude Code 配置

```bash
claude mcp add one-earbud -- node /你的路径/one-earbud/mcp-server.js
```
