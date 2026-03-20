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

// ─── Types ───────────────────────────────────────────────────────

export interface TopicItem {
  title: string;
  workspace: string;
  value: 'high' | 'medium' | 'low';
  need_deep_analysis: boolean;
  brief: string;
  related_jids: string[];
}

export interface TopicAnalysis {
  topics: TopicItem[];
}

export interface DeepAnalysisResult {
  topic: string;
  summary: string;
  decisions: string[];
  action_items: string[];
  insights: string[];
}

// ─── Claude CLI Wrapper ─────────────────────────────────────────

/**
 * Call Claude CLI in `--print` mode, piping the prompt via stdin.
 * Returns the raw text response, or null on failure.
 */
/**
 * Find the Claude CLI executable path.
 * Priority: global `claude` → agent-runner SDK's built-in `cli.js`
 */
function findClaudeCliPath(): { command: string; args: string[] } | null {
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
function findClaudeConfigDir(): string | undefined {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  const sessionDir = path.join(DATA_DIR, 'sessions', 'main', '.claude');
  const credFile = path.join(sessionDir, '.credentials.json');
  if (fs.existsSync(credFile)) return sessionDir;
  return undefined;
}

function callClaudeCli(prompt: string, model?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const cliPath = findClaudeCliPath();
    if (!cliPath) {
      console.error('[ai-client] Claude CLI not found');
      resolve(null);
      return;
    }

    const args = [...cliPath.args, '--print'];
    if (model) args.push('--model', model);

    // Inherit parent env and inject CLAUDE_CONFIG_DIR so CLI can find OAuth credentials.
    // Without this, launchd's minimal env causes "Not logged in".
    const configDir = findClaudeConfigDir();
    const env = { ...process.env };
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

    const child = execFile(cliPath.command, args, {
      maxBuffer: 10 * 1024 * 1024, // 10MB
      timeout: 120_000, // 2 minutes
      env,
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('[ai-client] claude CLI failed:', error.message);
        if (stderr) console.error('[ai-client] stderr:', stderr.slice(0, 500));
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
 * Try SDK first (API key or OAuth token), fall back to CLI.
 */
async function callClaude(prompt: string, model?: string): Promise<string | null> {
  const config = getClaudeApiConfig();

  // Use SDK if we have an API key or OAuth bearer token
  if (config?.apiKey || config?.authToken) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({
        apiKey: config.apiKey || undefined,
        authToken: config.authToken || undefined,
        baseURL: config.baseUrl || undefined,
      });
      const response = await client.messages.create({
        model: model || 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      return text;
    } catch (err: any) {
      console.warn('[ai-client] SDK call failed, falling back to CLI:', err.message);
    }
  }

  // Fall back to Claude CLI (with CLAUDE_CONFIG_DIR for OAuth)
  return callClaudeCli(prompt, model);
}

// ─── Analysis Functions ─────────────────────────────────────────

export async function analyzeTopics(
  messagesText: string,
  model = 'claude-haiku-4-5-20251001',
): Promise<TopicAnalysis> {
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
    if (!text) return { topics: [] };
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { topics: [] };
    return JSON.parse(jsonMatch[0]) as TopicAnalysis;
  } catch (err) {
    console.error('[daily-report] Pass 1 failed:', err);
    return { topics: [] };
  }
}

export async function deepAnalyzeTopic(
  topicTitle: string,
  conversationText: string,
  model = 'claude-sonnet-4-5-20250929',
): Promise<DeepAnalysisResult> {
  const empty: DeepAnalysisResult = { topic: topicTitle, summary: '', decisions: [], action_items: [], insights: [] };

  const prompt = `你是一个对话分析助手。深入分析关于特定主题的完整对话，提取关键信息。

要求：
1. 概要总结讨论内容
2. 提取做出的决策和结论
3. 提取待办事项和行动项
4. 提取有价值的洞察和反思

只返回 JSON，不要其他内容。

深入分析以下对话中关于「${topicTitle}」的讨论：

${conversationText}

返回 JSON 格式：
{
  "topic": "${topicTitle}",
  "summary": "详细总结",
  "decisions": ["决策1", "决策2"],
  "action_items": ["待办1", "待办2"],
  "insights": ["洞察1", "洞察2"]
}`;

  try {
    const text = await callClaude(prompt, model);
    if (!text) return empty;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return empty;
    return JSON.parse(jsonMatch[0]) as DeepAnalysisResult;
  } catch (err) {
    console.error('[daily-report] Pass 2 failed:', err);
    return empty;
  }
}
