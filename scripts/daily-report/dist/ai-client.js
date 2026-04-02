/**
 * AI Client — Two-pass conversation analysis via Claude CLI (`claude --print`).
 *
 * Uses the same auth mechanism as HappyClaw's /recall command:
 * - Supports both OAuth and API key authentication
 * - Falls back gracefully if Claude CLI is unavailable
 *
 * If ANTHROPIC_API_KEY is set, uses the SDK directly instead of CLI.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getClaudeApiConfig, DATA_DIR } from './config-reader.js';
// ─── Claude CLI Wrapper ─────────────────────────────────────────
/**
 * Call Claude CLI in `--print` mode, piping the prompt via stdin.
 * Returns the raw text response, or null on failure.
 */
/**
 * Find the Claude CLI executable path.
 * Priority: global `claude` → agent-runner SDK's built-in `cli.js`
 */
function findClaudeCliPath() {
    // Check agent-runner SDK (known location relative to project root)
    const projectRoot = path.resolve(DATA_DIR, '..');
    const sdkCli = path.join(projectRoot, 'container', 'agent-runner', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
    if (fs.existsSync(sdkCli)) {
        return { command: process.execPath, args: [sdkCli] };
    }
    // Fallback to global `claude` command
    return { command: 'claude', args: [] };
}
/**
 * Find a CLAUDE_CONFIG_DIR with valid .credentials.json for CLI auth.
 * Priority: env var → data/sessions/main/.claude/
 */
function findClaudeConfigDir() {
    if (process.env.CLAUDE_CONFIG_DIR)
        return process.env.CLAUDE_CONFIG_DIR;
    const sessionDir = path.join(DATA_DIR, 'sessions', 'main', '.claude');
    const credFile = path.join(sessionDir, '.credentials.json');
    if (fs.existsSync(credFile))
        return sessionDir;
    return undefined;
}
function callClaudeCli(prompt, model) {
    return new Promise((resolve) => {
        const cliPath = findClaudeCliPath();
        if (!cliPath) {
            console.error('[ai-client] Claude CLI not found');
            resolve(null);
            return;
        }
        const args = [...cliPath.args, '--print'];
        if (model)
            args.push('--model', model);
        // Inherit parent env and inject CLAUDE_CONFIG_DIR so CLI can find OAuth credentials.
        // Without this, launchd's minimal env causes "Not logged in".
        const configDir = findClaudeConfigDir();
        const env = { ...process.env };
        if (configDir)
            env.CLAUDE_CONFIG_DIR = configDir;
        const child = execFile(cliPath.command, args, {
            maxBuffer: 10 * 1024 * 1024, // 10MB
            timeout: 120_000, // 2 minutes
            env,
        }, (error, stdout, stderr) => {
            if (error) {
                console.error('[ai-client] claude CLI failed:', error.message);
                if (stderr)
                    console.error('[ai-client] stderr:', stderr.slice(0, 500));
                resolve(null);
                return;
            }
            resolve(stdout.trim());
        });
        if (child.stdin) {
            child.stdin.write(prompt);
            child.stdin.end();
        }
    });
}
/**
 * Try SDK first (API key / OAuth token via x-api-key), fall back to CLI.
 *
 * OAuth tokens passed as apiKey work for Haiku but return 400 for Sonnet/Opus.
 * When SDK fails, CLI fallback uses the Agent SDK's internal OAuth flow which
 * supports all models.
 */
const SDK_MAX_RETRIES = 3;
const SDK_RETRY_BASE_MS = 5_000;
// OAuth tokens (sk-ant-oat-*) only support Haiku via SDK.
// Sonnet/Opus always fail with 429, so skip SDK and go straight to CLI.
const SDK_SUPPORTED_MODELS = ['claude-haiku-4-5-20251001'];
function isSdkCompatibleModel(model) {
    if (!model)
        return true; // default is Haiku
    return SDK_SUPPORTED_MODELS.some(m => model.includes(m) || model.includes('haiku'));
}
async function callClaude(prompt, model) {
    const config = getClaudeApiConfig();
    const isOAuthToken = config?.apiKey?.startsWith('sk-ant-oat');
    // SDK path: only for real API keys, or OAuth tokens with Haiku
    if (config?.apiKey && (!isOAuthToken || isSdkCompatibleModel(model))) {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({
            apiKey: config.apiKey,
            baseURL: config.baseUrl || undefined,
        });
        for (let attempt = 0; attempt < SDK_MAX_RETRIES; attempt++) {
            try {
                const response = await client.messages.create({
                    model: model || 'claude-haiku-4-5-20251001',
                    max_tokens: 4000,
                    messages: [{ role: 'user', content: prompt }],
                });
                const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
                return text;
            }
            catch (err) {
                const status = err.status || err.statusCode;
                if (status === 429 && attempt < SDK_MAX_RETRIES - 1) {
                    const delay = SDK_RETRY_BASE_MS * (attempt + 1);
                    console.log(`[ai-client] SDK 429 rate limited (model=${model || 'default'}), retrying in ${delay / 1000}s (attempt ${attempt + 1}/${SDK_MAX_RETRIES})...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                console.log(`[ai-client] SDK call failed (model=${model || 'default'}), falling back to CLI: ${status || ''} ${err.message?.slice(0, 100)}`);
                break;
            }
        }
    }
    else if (isOAuthToken && !isSdkCompatibleModel(model)) {
        console.log(`[ai-client] OAuth token detected, skipping SDK for ${model}, using CLI directly`);
    }
    // Fall back to Claude CLI — uses Agent SDK's internal OAuth flow, supports all models
    return callClaudeCli(prompt, model);
}
// ─── Analysis Functions ─────────────────────────────────────────
export async function analyzeTopics(messagesText, model = 'claude-haiku-4-5-20251001') {
    const prompt = `你是一个对话分析助手。分析用户与 AI 助手之间的对话记录，识别讨论主题。

要求：
1. 识别所有不同的讨论主题
2. 对每个主题评估价值等级（high/medium/low）
3. 标记需要深入分析的高价值主题（need_deep_analysis=true）
4. high 价值标准：涉及重要决策、深度讨论、产出具体成果
5. low 价值标准：简单问答、日常闲聊、工具调用输出

只返回 JSON，不要其他内容。

分析以下对话记录，识别讨论主题：

${messagesText}

返回 JSON 格式：
{
  "topics": [
    {
      "title": "主题名称",
      "workspace": "工作区名称",
      "value": "high|medium|low",
      "need_deep_analysis": true/false,
      "brief": "一句话描述",
      "related_jids": ["相关的jid"]
    }
  ]
}`;
    try {
        const text = await callClaude(prompt, model);
        if (!text) {
            console.log('[daily-report] ⚠ Pass 1: AI 返回空结果，跳过主题分析');
            return { topics: [] };
        }
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.log('[daily-report] ⚠ Pass 1: AI 返回非 JSON 格式:', text.slice(0, 200));
            return { topics: [] };
        }
        const result = JSON.parse(jsonMatch[0]);
        if (result.topics.length === 0) {
            console.log('[daily-report] ⚠ Pass 1: AI 未识别出任何主题（输入消息可能全是系统/任务输出）');
        }
        return result;
    }
    catch (err) {
        console.log('[daily-report] ⚠ Pass 1 失败:', err);
        return { topics: [] };
    }
}
export async function deepAnalyzeTopic(topicTitle, conversationText, model = 'claude-sonnet-4-5-20250929') {
    const empty = { topic: topicTitle, summary: '', decisions: [], action_items: [], insights: [] };
    const prompt = `你是一个对话分析助手。深入分析关于特定主题的完整对话，提取关键信息。

要求：
1. 概要总结讨论内容
2. 提取做出的决策和结论
3. 提取待办事项和行动项（action_items）——这是重点，请仔细提取：
   - 对话中明确提到「要做」「下一步」「待」「TODO」「需要」「得去」「回头」「后面再」等意图的事项
   - 讨论后产生的、尚未执行的后续行动（如：方案待确认、功能待开发、问题待修复、需要跟进的事）
   - 排除已经完成的事项，只保留未完成的
   - 如果对话中确实没有待办事项，返回空数组即可，不要硬凑
4. 提取有价值的洞察和反思

只返回 JSON，不要其他内容。

深入分析以下对话中关于「${topicTitle}」的讨论：

${conversationText}

返回 JSON 格式：
{
  "topic": "${topicTitle}",
  "summary": "详细总结",
  "decisions": ["决策1", "决策2"],
  "action_items": ["具体的待办事项描述，包含足够上下文让人知道要做什么"],
  "insights": ["洞察1", "洞察2"]
}`;
    try {
        const text = await callClaude(prompt, model);
        if (!text) {
            console.warn(`[daily-report] Pass 2 (${topicTitle}): callClaude returned empty`);
            return empty;
        }
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn(`[daily-report] Pass 2 (${topicTitle}): no JSON found in response:`, text.slice(0, 200));
            return empty;
        }
        return JSON.parse(jsonMatch[0]);
    }
    catch (err) {
        console.error(`[daily-report] Pass 2 (${topicTitle}) failed:`, err);
        return empty;
    }
}
