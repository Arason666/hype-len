# HYPE Lens

一个零服务器费用的 HYPE 相对强弱监控面板。它使用 Hyperliquid 公共 K 线计算：

- `ETH/HYPE = ETH 价格 ÷ HYPE 价格`
- `BTC/HYPE = BTC 价格 ÷ HYPE 价格`
- 15 分钟、1 小时、4 小时、1 日趋势
- EMA 8 / EMA 21 多周期状态
- 1 小时、4 小时、24 小时变化
- 飞书或 Telegram 定时告警

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

## 配置告警

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

## 免费方案限制

- GitHub Pages 是公开静态网页，没有原生密码保护。
- GitHub Actions 的定时任务可能出现几分钟延迟，不适合自动交易执行。
- 浏览器会缓存最近一次成功行情，在临时断网时显示缓存并明确标注。
- 页面每 5 分钟自动刷新；指标只使用已经结束的 K 线。

## 数据与风险

数据来自 Hyperliquid 公共行情接口。该项目只提供趋势观察，不构成投资建议。
