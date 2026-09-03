# HYPE Lens

一个零服务器费用的 HYPE 相对强弱监控面板。它使用 Hyperliquid 公共 K 线计算：

- `ETH/HYPE = ETH 价格 ÷ HYPE 价格`
- `BTC/HYPE = BTC 价格 ÷ HYPE 价格`
- 15 分钟、1 小时、4 小时、1 日趋势
- EMA 8 / EMA 21 多周期状态
- 1 小时、4 小时、24 小时变化
- 过去 180 日趋势状态、动态回撤线和相对 BTC/ETH 表现
- 前约 150 日滚动选择参数、后 30 日样本外测试的事件驱动趋势模型
- 趋势识别率、趋势收益捕获率、进场延迟、过早退出、重复信号、净收益和最大回撤验证
- 价格回撤确认的反转退出、同方向重入锁与冷却期，减少趋势中途反复开平仓
- 免费采集 HYPE 持仓量、资金费率、溢价、盘口深度与近期主动成交结构
- HYPE 重点 X 账号官方时间线
- X API 每 15 分钟自动采集和服务端规则分析
- 每天最多 20 条新帖、预估费用最多 `$0.15` 的硬保护
- 观点发布后 15 分钟、1 小时、4 小时、1 日和 7 日的价格验证
- 飞书或 Telegram 定时趋势告警
- 秒级 HYPE 到价预警、ntfy 强推、腾讯云电话升级与触发日志

比值下降表示 HYPE 相对走强，比值上涨表示 HYPE 相对走弱。

## 本地预览

项目不依赖 Node.js 或第三方 Python 包：

```bash
python3 -m http.server 8080 --directory site
```

然后访问 `http://localhost:8080`。

运行检查：

```bash
python3 scripts/validate_site.py
python3 -m unittest discover -s tests -v
```

## 免费部署到 GitHub Pages

1. 在 GitHub 新建一个公开仓库，例如 `hype-lens`。
2. 将本项目推送到仓库的 `main` 分支。
3. 打开仓库 `Settings → Pages`，将 Source 设为 `GitHub Actions`。
4. 等待 `Deploy dashboard to GitHub Pages` 工作流完成。
5. 页面地址通常是 `https://<用户名>.github.io/hype-lens/`。

`.github/workflows/pages.yml` 已包含完整发布流程，推送到 `main` 后会自动更新网页。

## 免费市场结构数据

`Collect HYPE market context` 每 15 分钟调用 Hyperliquid 公共接口，无需密钥，也不会消耗 X API 预算。公开数据保存在 `site/data/market-context.json`：

- 15 分钟市场快照保留 60 天。
- 小时资金费率保留 180 天，首次运行自动分页回填。
- 页面实时参考持仓量变化、资金费率/溢价拥挤度、前 10 档盘口失衡和近期主动买卖占比。
- 历史样本积累不足时，这些结构数据只修正当前提示，不进入既有 30 天回测，避免把未来数据混入测试。

## 配置趋势告警

行情检查工作流每 15 分钟 K 线结束后运行一次。进入仓库：

`Settings → Secrets and variables → Actions`

按需要添加 Repository secrets：

| 名称 | 用途 |
|---|---|
| `FEISHU_WEBHOOK` | 飞书群自定义机器人 webhook |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot token |
| `TELEGRAM_CHAT_ID` | Telegram 接收人或群组 ID |

飞书和 Telegram 可以只配置其中一个。不要把密钥写进 `site/app.js` 或提交到仓库。

建议再添加 Repository variable：

| 名称 | 示例 |
|---|---|
| `DASHBOARD_URL` | `https://<用户名>.github.io/hype-lens/` |

配置完成后，可以在 Actions 页面手动运行 `Check HYPE relative-strength signals`，勾选测试告警验证渠道。

## 配置实时价格预警

实时到价预警不能依赖 GitHub Pages 或浏览器常驻。`scripts/price_alert_service.py` 是独立的轻量服务：默认每 3 秒一次性读取 Hyperliquid 的 HYPE、ETH 与 BTC 标记价格，按规则所选币种判断，连续确认 3 次后触发 ntfy；若仍未在看板确认，可在 45 秒后调用腾讯云监控电话策略。

### 1. 手机安装 ntfy

在 OPPO 手机上建议安装 F-Droid 版 ntfy，订阅一个难以猜测的主题，并在 ColorOS 中允许：通知、锁屏通知、后台运行、自启动和忽略电池优化。把该主题设置成高优先级声音；如需在静音/勿扰下响铃，再用 MacroDroid 接收 ntfy 通知并临时提高闹钟音量。

### 2. 在常驻服务器设置环境变量

不要把真实值提交到 GitHub。下面命令只是当前终端的启动示例：

```bash
export ALERT_API_TOKEN="请替换为至少16位的随机密钥"
export ALERT_ALLOWED_ORIGIN="https://northinterval.com"
export ALERT_STATE_PATH="/var/lib/hype-lens/price-alert-state.json"
export ALERT_BIND_HOST="127.0.0.1"
export ALERT_PORT="8787"
export ALERT_POLL_SECONDS="3"
export ALERT_SESSION_SECONDS="2592000"

export NTFY_URL="https://ntfy.sh"
export NTFY_TOPIC="请替换为你的私有主题"
export NTFY_ACCESS_TOKEN="可选；使用受保护主题时填写"
export DASHBOARD_URL="https://northinterval.com/"

python3 scripts/price_alert_service.py
```

生产环境需通过 Caddy、Nginx 或 Cloudflare Tunnel 暴露 HTTPS 地址，例如 `https://alerts.example.com`。GitHub Pages 是 HTTPS 页面，浏览器会阻止它直接调用未加密的 HTTP 服务。

仓库的 `Deploy price alert server` 工作流会通过 SSH 安装 systemd 服务与 Caddy。服务器只在本机监听 `127.0.0.1:8787`，公网仅开放 `80/443`；部署私钥、API 访问密钥和 ntfy 主题均保存在 GitHub Actions Secrets 中。

如果需要电话升级，再增加：

```bash
export TENCENTCLOUD_SECRET_ID="腾讯云 API SecretId"
export TENCENTCLOUD_SECRET_KEY="腾讯云 API SecretKey"
export TENCENT_MONITOR_POLICY_ID="已绑定本人电话通知模板的自定义告警策略 ID"
export TENCENTCLOUD_REGION="ap-guangzhou"
```

腾讯云密钥只存在服务端。建议创建权限受限的子用户，只允许发送云监控自定义告警；电话策略中只填写本人的手机号，并开启按键确认。

### 3. 在看板配置目标价

打开 `价格预警` 页签：

1. 看板默认连接 `https://alerts.northinterval.com`。每台设备首次使用时填写一次 `ALERT_API_TOKEN` 并点击“配对此设备”；浏览器会打开同域安全配对页、签发 30 天有效的 `HttpOnly + Secure` Cookie，再自动返回看板。网页不会永久保存原始密钥。若手机浏览器没有跳转，可点“手机仍无法配对？打开独立安全配对页”。
2. 选择 `HYPE`、`ETH` 或 `BTC`，再选择“下跌至或低于”或“上涨至或高于”，输入目标价格。
3. 勾选 `ntfy 强推`；确认腾讯云策略测试成功后再勾选“未确认后电话升级”。
4. 默认保留连续确认 `3` 次、电话延迟 `45` 秒、冷却 `15` 分钟、重新布防缓冲 `0.25%`。
5. 点击“保存并启用”。规则必须显示“已布防”才算真正运行。
6. 分别点击“测试强推”和“测试电话”。测试电话可能产生语音通知费用。

关闭网页、电脑或手机屏幕后，已经保存的规则仍由腾讯云服务器持续执行。重新打开看板时会自动使用设备配对 Cookie 连接；可以随时点击“断开 / 重新配对”，该操作不会停止或删除服务器上的规则。

日志会保留最近 300 条事件，包括触发时间、阈值、实际价格、各渠道结果、确认时间和重新布防时间。访问密钥只在首次配对请求中使用，不写入 `localStorage` 或 `sessionStorage`；服务器上的规则始终独立运行。

## 配置付费 X 自动采集

在 Repository secrets 中添加：

| 名称 | 用途 |
|---|---|
| `X_BEARER_TOKEN` | X Developer App 的只读 Bearer Token |

`Collect paid X opinions` 工作流每 15 分钟运行一次。采集器使用北京时间日账本，并在每次请求前按最坏情况预留费用：

- 每天最多自动分析 20 条新帖。
- 每天预估 X API 费用最多 `$0.15`。
- 达到任一上限后，当天不再调用帖子时间线接口。
- 次日自动清零日用量，账号 ID 和 `since_id` 会继续保留。
- 密钥只存在 GitHub Secrets，不会写入日志、网页或仓库。

自动生成的公开帖子、分析结果和用量摘要保存在 `site/data/x-posts.json`；去重游标和日账本保存在 `data/x-monitor-state.json`。

## 免费方案限制

- GitHub Pages 是公开静态网页，没有原生密码保护。
- GitHub Actions 的定时任务可能出现几分钟延迟，不适合自动交易执行。
- 实时价格预警必须部署常驻服务；只打开静态看板并不会在后台监控。
- ntfy、电话、移动网络和 ColorOS 省电策略都可能延迟或丢失通知，交易所条件止损必须独立存在。
- 浏览器会缓存最近一次成功行情，在临时断网时显示缓存并明确标注。
- 页面每 5 分钟自动刷新；指标只使用已经结束的 K 线。
- X API 本身按读取量计费，程序显示的是基于当前官方单价的保守预估值；应定期核对 X Developer Console 的实际余额和价格。
- Hyperliquid 市场结构采集使用免费公开接口，但 GitHub Actions 定时运行可能有延迟或偶发缺口。
- 自动观点保存在仓库公开数据文件中；手动补充的观点仍只保存在当前浏览器。
- 当前服务端规则模型用于监控和初筛，不等同于专业投研或投资建议。
- 趋势模型按时间顺序训练/测试；开发迭代期间看到的最后 30 天结果属于持续样本外验证，不应再称作完全未观察的封存测试。上线后应继续按月滚动记录，防止参数只适合当前市场阶段。
- 趋势识别率、收益捕获率、进场延迟、退出回吐、手续费、滑点和资金费率应一起评估，不能只看单一胜率。

## 数据与风险

数据来自 Hyperliquid 公共行情接口。该项目只提供趋势观察，不构成投资建议。
