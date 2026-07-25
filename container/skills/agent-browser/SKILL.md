---
name: agent-browser
description: Browse the web for any task — research topics, read articles, interact with web apps, fill forms, take screenshots, extract data, and test web pages. Use whenever a browser would be useful, not just when the user explicitly asks.
allowed-tools: Bash(agent-browser:*)
---

# Browser Automation with agent-browser

## Core workflow

1. Navigate: `agent-browser open <url>`
2. Snapshot: `agent-browser snapshot -i` — returns interactive elements with refs like `@e1`, `@e2`
3. Interact using the refs
4. Re-snapshot after navigation or significant DOM changes
5. **Finish with `agent-browser close`** — required, see below

## 用完必须关闭

浏览器进程在多次 `agent-browser` 调用之间保持存活（这正是上一次 `snapshot` 拿到的
`@e1` 还能用的原因），并且它是 detached 的——不会随任务结束自动退出。

**任务结束前必须执行 `agent-browser close`。** 忘记关闭会留下常驻的 Chromium：
曾经累积到 43 个进程、772% CPU、17% 内存。

- 单个会话：`agent-browser close`
- 排查残留：`agent-browser session list`
- 不要用 `close --all`：它会关掉机器上所有会话，可能影响其他工作区

即使忘了，宿主机模式下 HappyClaw 会在 agent 进程退出时按会话名兜底关闭一次；
但那是兜底，不是替代——中途换任务、长时间不退出的会话仍会占资源。

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i        # → textbox "Email" [ref=e1], button "Submit" [ref=e2]
agent-browser fill @e1 "user@example.com"
agent-browser click @e2
agent-browser wait --load networkidle
agent-browser snapshot -i        # check result
```

## Command reference (one line per family)

| 类别 | 命令 |
|------|------|
| 导航 | `open <url>` / `back` / `forward` / `reload` / `close` |
| 页面分析 | `snapshot -i`（交互元素，推荐）；`-c` 紧凑、`-d N` 限深、`-s "<css>"` 限范围 |
| 交互 | `click` / `dblclick` / `fill`（清空后输入）/ `type` / `press Enter` / `hover` / `check` / `uncheck` / `select` / `scroll down 500` / `upload @e1 file.pdf` |
| 取值 | `get text|html|value|attr|title|url|count <目标>` |
| 截图/PDF | `screenshot [path] [--full]` / `pdf out.pdf` |
| 等待 | `wait @e1` / `wait 2000` / `wait --text "OK"` / `wait --url "**/dash"` / `wait --load networkidle` |
| 语义定位 | `find role button click --name "Submit"` / `find text|label|placeholder ... <action>` |
| 登录态 | 登录后 `state save auth.json`，下次 `state load auth.json` |
| Cookie/存储 | `cookies [set k v|clear]` / `storage local [set k v]` |
| JS | `eval "document.title"` |

完整参数和更多子命令：`agent-browser --help` 或 `agent-browser <command> --help`。
