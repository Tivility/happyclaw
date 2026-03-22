---
name: create-feishu-workspace
description: >
  创建飞书群组并绑定为 HappyClaw 独立工作区。支持自动生成头像（Seedream）、
  选择执行模式（host/container）、添加用户到群组。
  一站式完成：建群 → 生头像 → 设头像 → 建工作区 → 绑定。
user-invocable: true
argument-hint: <群名> [头像风格描述]
allowed-tools: Bash(node:*)
---

# 创建飞书工作区

一键创建飞书群组并绑定为 HappyClaw 独立工作区。

## 使用方式

```
/create-feishu-workspace 锻造台 暗黑工业风锻造炉蓝色火焰
```

参数：
- 第一个参数：**群名**（必填）
- 后续参数：**头像风格描述**（可选，用于 Seedream 生成头像）

## 执行流程

收到用户请求后，按以下步骤执行：

### 1. 确认参数

从用户输入中提取：
- `name`：群组名称（必填）
- `avatarPrompt`：头像生成提示词（可选，如未提供则根据群名自动构造）
- `executionMode`：执行模式（默认 `host`，可选 `container`）

如果用户没有指定执行模式，默认使用 `host`（宿主机模式）。
如果用户没有提供头像描述，根据群名主题自动构造一个风格统一的提示词（东方美学 + 暗色调 + 方形头像构图）。

### 2. 运行创建脚本

脚本位于技能目录中，路径通过 `__dirname` 或已知的项目结构定位：

```bash
node "<happyclaw-root>/container/skills/create-feishu-workspace/create-workspace.mjs" \
  --name "群名" \
  --mode "host" \
  --avatar-prompt "头像生成提示词" \
  --happyclaw-root "<happyclaw-root>"
```

**路径确定方法**：
- 宿主机模式：HappyClaw 根目录通常为 `/Users/tivility/happyclaw`（从 CWD `data/groups/{folder}` 向上推导）
- 容器模式：项目根目录挂载在 `/workspace/project`

**环境变量**：
- `ARK_API_KEY`：火山引擎 Seedream API Key（头像生成必需）。如未设置，脚本会跳过头像生成。

### 3. 报告结果

脚本输出 JSON 结果，包含：
- `chatId`：飞书群 ID
- `folder`：HappyClaw 工作区 folder
- `name`：群名
- `avatarSet`：是否成功设置头像

向用户汇报创建结果。绑定通过 API 完成，无需重启服务即可生效。

## 头像提示词模板

为保持风格统一，头像提示词应包含以下要素：
- 明确的主题意象（与群名相关）
- `暗色背景` 或 `深色调`
- `方形头像构图`
- `高级质感` 或 `3D渲染`
- 具体的艺术风格（如东方美学、赛博朋克、工业风等）

示例：
```
东方美学图标设计，一卷微微展开的竹简，旁边搁着一支毛笔，暗色木质桌面背景，
温暖的烛光侧照，水墨质感，方形头像构图，极简古典，高级3D渲染
```

## 注意事项

- 飞书群创建需要 bot 具有 `im:chat` 权限
- 头像生成使用火山引擎 Seedream 5.0（doubao-seedream-5-0-260128），最小分辨率 2048x2048
- 用户 open_id 从飞书配置中的最近消息上下文获取，或使用脚本的 `--user-open-id` 参数指定
