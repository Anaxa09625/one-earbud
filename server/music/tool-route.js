'use strict';
// MCP 桥接路由：POST /music/tool
// 接收 { action, ...params }，转发给 tool-contract 的 handler，返回结果。
// 这样 MCP server 不用直接访问 authority 内存，走 HTTP 即可。

const { createTaMusicTool } = require('../agent/tool-contract');

function mountToolRoute(router, authority) {
  const tool = createTaMusicTool({ authority });

  router.post('/music/tool', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await tool.handler(req.body || {});
      res.json(result);
    } catch (e) {
      const code = (e && e.code) || 'TOOL_ERROR';
      const status = code.startsWith('MUSIC_') ? 502 : 400;
      res.status(status).json({ ok: false, error: code, message: String(e.message || '') });
    }
  });
}

module.exports = { mountToolRoute };
