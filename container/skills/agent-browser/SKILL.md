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
