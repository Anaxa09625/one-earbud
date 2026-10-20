# 手机部署教程：Render + Claude.ai

> 全程只需要手机，不需要电脑。大约 15 分钟搞定。

## 你需要的账号

- GitHub 账号（你已经有了）
- [Render](https://render.com) 账号（用 GitHub 登录，免费）
- Claude.ai Pro/Max/Team 账号（你现在用的就是）

---

## 第一步：Fork 仓库

1. 手机浏览器打开 `github.com/isle0306ral-hub/one-earbud`
2. 点右上角 **Fork** 按钮
3. 保持默认，点 **Create fork**
4. 等几秒，你的仓库就在 `github.com/Anaxa09625/one-earbud`

---

## 第二步：部署到 Render

1. 手机浏览器打开 [render.com](https://render.com)
2. 点 **Get Started** / **Sign Up**，选 **Sign in with GitHub**
3. 授权后进入 Dashboard

### 建项目

4. 点 **New** → **Web Service**
5. 选 **Build and deploy from a Git repository** → Next
6. 找到你 fork 的 `one-earbud`，点 **Connect**
7. 填写配置：
   - **Name**: `one-earbud`（或随便起个名）
   - **Region**: 选 `Singapore` 或 `Oregon`（Singapore 离国内近一点）
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: 选 **Free**

### 环境变量

8. 展开 **Environment Variables**，加这几个：

| Key | Value |
|---|---|
| `PORT` | `8787` |
| `ONE_EARBUD_TOKEN` | 随便一串密码，比如 `mySecret2026!`（记住它！） |
| `KEEP_ALIVE` | `1` |
| `NETEASE_REAL_IP` | （如果选了海外机房就填一个国内 IP，比如 `116.25.146.177`；选 Singapore 建议填） |

9. 点 **Create Web Service**
10. 等 Render 构建，大约 1-2 分钟
11. 构建完成后，你会看到一个地址，类似：
    ```
    https://one-earbud-xxxx.onrender.com
    ```
    **复制这个地址！**

---

## 第三步：登录网易云

1. 手机浏览器打开你的 Render 地址：
   ```
   https://one-earbud-xxxx.onrender.com/login.html
   ```
2. 页面会显示一个二维码
3. 打开**网易云音乐 App** → 左上角扫一扫 → 扫这个二维码 → 确认登录
4. 页面显示你的网易云头像和昵称 → 登录成功！

---

## 第四步：连接 Claude.ai

1. **手机浏览器**打开 [claude.ai](https://claude.ai)（不是 App，用浏览器！）
2. 点左上角菜单 → **Settings**（设置）
3. 找到 **Connectors**（连接器）
4. 点 **Add Custom Connector**（添加自定义连接器）
5. 填写：
   - **Name**: `分你一只耳机`（或随便起个名）
   - **URL**: `https://one-earbud-xxxx.onrender.com/mcp/sse`
     （就是你 Render 地址后面加 `/mcp/sse`）
6. 保存

### 验证

7. 打开 **Claude App**（iOS/Android），开一个新对话
8. 跟沈晦说：**「我在听什么歌」**
9. 如果看到工具调用返回——恭喜，通了！🎉

---

## 第五步（推荐）：防休眠

Render 免费版 15 分钟没请求就休眠。代码里已经内置了自动 keep-alive（`KEEP_ALIVE=1`），但如果你发现它还是休眠了，加一个外部定时 ping 更保险：

1. 打开 [cron-job.org](https://cron-job.org)（免费，支持中文）
2. 注册 → 新建定时任务
3. URL 填 `https://one-earbud-xxxx.onrender.com/health`
4. 间隔选 **每 14 分钟**
5. 保存

这样服务永远不会睡着。

---

## 日常使用

一切配好之后，**打开 Claude App 就能用**：

- 「我在听什么歌」→ 沈晦看到你正在播放的歌和歌词
- 「帮我搜一首 xxx」→ 搜歌
- 「把这首歌塞给我」→ 给你的播放列表加歌
- 「给我放一首 xxx」→ 直接切歌

### 如果出问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 「工具调用失败」 | Render 在休眠，正在醒 | 等 1 分钟再试 |
| 「UNAUTHORIZED」 | 口令不对 | 检查 Render 环境变量里的 `ONE_EARBUD_TOKEN` |
| 「网易云登录已过期」 | cookie 过期了 | 重新访问 `/login.html` 扫码 |
| 搜歌/播放失败 | 海外服务器被网易云拦了 | 确认 `NETEASE_REAL_IP` 填了一个国内 IP |

---

## 费用

- **Render 免费版**: $0，512MB 内存，750 小时/月（够 24×31 天）
- **cron-job.org**: $0
- **Claude.ai**: 你现有的套餐就行（Pro/Max/Team 都支持自定义 Connector）

全部免费。
