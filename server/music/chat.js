'use strict';
// 分你一只耳机 · 简单聊天：景桦和沈晦在听歌页面里发消息
// 内存 + 文件持久化，最多保留 200 条

const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'chat.json');

function createChat() {
  let messages = [];
  // 加载历史
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    messages = JSON.parse(raw);
    if (!Array.isArray(messages)) messages = [];
  } catch (_) { messages = []; }

  function save() {
    try {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(messages.slice(-200)));
    } catch (_) {}
  }

  return {
    // 发一条消息
    send({ from, text, songCard }) {
      if (!from || (!text && !songCard)) return null;
      const msg = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        from,          // 'you' | 'ta'
        text: text || '',
        songCard: songCard || null,  // { songId, title, artist, coverUrl }
        ts: Date.now()
      };
      messages.push(msg);
      if (messages.length > 200) messages = messages.slice(-200);
      save();
      return msg;
    },
    // 拿消息：since 之后的（时间戳），最多 50 条
    list({ since = 0, limit = 50 } = {}) {
      const after = messages.filter(m => m.ts > since);
      return after.slice(-limit);
    },
    // 全部（最近 50 条）
    recent(n = 50) {
      return messages.slice(-n);
    }
  };
}

module.exports = { createChat };
