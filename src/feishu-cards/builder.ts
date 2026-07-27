/**
 * Top-level Feishu v2 Agent reply card builders.
 *
 *   buildAgentReplyCard(input)
 *       Terminal (static) card. Header is status-driven: a successful `done`
 *       reply drops the header (unless an explicit title is passed) so short
 *       status messages aren't reduced to a truncated header, while
 *       running/warning/error keep a status-coloured header. Followed by body
 *       chunks + metadata row (2×2) + optional thinking/tool panels + footer.
 *       Suitable for finalized Agent replies and error cards.
 *
 *   buildStreamingAgentCard(opts)
 *       Initial streaming skeleton. Preserves the 5 slot element_ids that
 *       feishu-streaming-card.ts patches via cardElement.content(). The aux
 *       before/after slots remain plain markdown so the existing flush loop
 *       keeps working unchanged.
 */

import {
  optimizeMarkdownStyle,
} from '../feishu-markdown-style.js';
import type {
  AgentCardInput,
  CardMeta,
  FeishuCardV2,
} from './types.js';
import {
  buildHeader,
  buildMetaRow,
  buildBodyChunks,
  buildThinkingPanel,
  buildPriorSegmentsPanels,
  buildSubAgentPanels,
  buildCodexTodoPanel,
  buildCodexOperationsPanel,
  buildStreamingPanels,
  buildStatusBannerText,
  buildLocalDatetimeWithSeconds,
  extractTitle,
  statusHeadline,
  CARD_ELEMENT_IDS,
  type StreamingCardRuntimeProfile,
  type StreamingPanelsInit,
} from './sections.js';

/** Per-platform typewriter tuning — mobile feels faster, PC breathes more. */
const STREAMING_CONFIG = {
  print_frequency_ms: { default: 30, android: 25, ios: 40, pc: 50 },
  print_step: { default: 2, android: 3, ios: 4, pc: 5 },
  print_strategy: 'fast' as const,
};

export function buildAgentReplyCard(input: AgentCardInput): FeishuCardV2 {
  // Apply Feishu-friendly markdown transformation once, up front.
  const optimizedText = optimizeMarkdownStyle(input.text, 2);
  const optimizedThinking = input.thinking
    ? optimizeMarkdownStyle(input.thinking, 2)
    : undefined;

  const explicitTitle = input.title?.trim();
  const body = optimizedText.trim();

  // Header policy: always render a status-coloured header so the
  // streaming→terminal transition stays visually consistent (blue「生成中」→
  // violet「已完成」is a colour change, not a header that suddenly vanishes).
  // The header title is the explicit title when present, otherwise a minimal
  // status word ('已完成'/'已中断'/'出错') — NEVER the body's first line, which
  // was the root cause of the header/first-line duplication (issue #488). Using
  // a fixed status word for `done` keeps issue #488 fixed while still giving the
  // completed reply a clear status anchor.
  const headlineTitle = explicitTitle ?? statusHeadline(input.status);
  const summaryTitle = input.titlePrefix
    ? `${input.titlePrefix}${headlineTitle}`
    : headlineTitle;

  const normalizedInput: AgentCardInput = {
    ...input,
    text: optimizedText,
    title: explicitTitle,
    thinking: optimizedThinking,
  };

  const header = buildHeader(normalizedInput);

  // New layout: Header → process panels (collapsed) → hr → Body → metaRow.
  //
  // Process-area panels in order of "abstract → concrete → prelude":
  //   1. codex todos/operations (Codex SDK process artifacts, when present)
  //   2. thinking     (what the agent was reasoning about)
  //   3. sub-agents   (discrete sub-tasks delegated to Task/Agent tools)
  //   4. prior text   (earlier assistant segments, closest to final Body)
  //
  // Note: tools panel intentionally omitted — per-tool stats clutter the
  //       final card; users care about sub-agent results, not tool counts.
  const thinkingPanel = buildThinkingPanel(optimizedThinking);
  const codexTodoPanel = buildCodexTodoPanel(input.codexTodos);
  const codexOperationsPanel = buildCodexOperationsPanel(input.codexOperations);
  const subAgentPanels = buildSubAgentPanels(input.subAgentResults);
  const priorSegmentsPanels = buildPriorSegmentsPanels(input.priorTextSegments);
  const metaRow = buildMetaRow(input.meta, input.completedAtMs);

  const elements: Array<Record<string, unknown>> = [];

  // ── Process area (all collapsed by default) ──
  elements.push(...codexTodoPanel);
  elements.push(...codexOperationsPanel);
  elements.push(...thinkingPanel);
  elements.push(...subAgentPanels);
  elements.push(...priorSegmentsPanels);

  const hasProcessArea =
    codexTodoPanel.length +
    codexOperationsPanel.length +
    thinkingPanel.length +
    subAgentPanels.length +
    priorSegmentsPanels.length > 0;

  // ── Divider between process area and main content ──
  if (hasProcessArea) {
    // Native v2 hr — components.md §hr confirms it's a valid component outside
    // of CardKit's live-streaming patch surface.
    elements.push({ tag: 'hr' });
  }

  // ── Main content (Body) ──
  elements.push(...buildBodyChunks(body || optimizedText.trim()));

  // ── Footer: metaRow 携带时间戳（取代旧的独立 footer 时间戳）──
  elements.push(...metaRow);
  // input.footer 折叠进 metaRow 之后作为同一行的续行，不另起 FOOTER 元素
  // （本地契约：终态卡只有一个紧凑元信息行）。它承载 metaRow 覆盖不到的内容，
  // 典型是执行轨迹链接 [查看完整运行轨迹](...)。
  const footerText = input.footer?.trim();
  if (footerText) {
    if (metaRow.length > 0) {
      const last = metaRow[metaRow.length - 1] as { content?: string };
      last.content = `${last.content ?? ''}\n${footerText}`;
    } else {
      elements.push({
        tag: 'markdown',
        text_size: 'notation',
        content: `<font color='grey'>${footerText}</font>`,
        element_id: CARD_ELEMENT_IDS.META_ROW,
      });
    }
  }

  const config: Record<string, unknown> = {
    update_multi: true,
    enable_forward: true,
    width_mode: 'fill',
  };
  if (summaryTitle) {
    config.summary = { content: summaryTitle };
  }

  const card: FeishuCardV2 = {
    schema: '2.0',
    config,
    header,
    body: {
      direction: 'vertical',
      vertical_spacing: 'medium',
      elements,
    },
  };
  return card;
}

export interface StreamingCardBuildOptions {
  /** Initial text to seed into the MAIN_CONTENT slot. */
  initialText?: string;
  /** Optional override title (otherwise extracted from initialText). */
  title?: string;
  /** Optional title prefix (e.g. AI name). */
  titlePrefix?: string;
  /** Optional subtitle shown under the title. */
  subtitle?: string;
  /** Optional meta (currently only `model` is used for the header tag). */
  meta?: Pick<CardMeta, 'model'>;
  /** Runtime profile controls streaming panel labels/placeholders. */
  runtimeProfile?: StreamingCardRuntimeProfile;
  /** Initial content for structured runtime panels. */
  panels?: StreamingPanelsInit;
  /**
   * If true, use the "rich" structured skeleton (runtime panels + footer
   * status). If false, use the legacy flat skeleton (AUX_BEFORE/AUX_AFTER).
   * Default: true.
   */
  rich?: boolean;
}

export function buildStreamingAgentCard(
  opts: StreamingCardBuildOptions = {},
): FeishuCardV2 {
  const initialText = opts.initialText ?? '';
  // 空正文时给占位，避免飞书 markdown 元素内容为空导致整卡渲染失败（upstream）
  const visibleInitialText =
    initialText.trim() || '> 正在分析请求，最终结论完成后会显示在这里。';
  const { title: autoTitle } = extractTitle(initialText);
  const baseTitle = opts.title ?? autoTitle ?? 'Agent 回复';
  const displayTitle = `${baseTitle} · 生成中`;
  const useRich = opts.rich !== false;

  const header = buildHeader({
    text: initialText,
    status: 'running',
    title: displayTitle,
    titlePrefix: opts.titlePrefix,
    subtitle: opts.subtitle,
    meta: opts.meta ? { model: opts.meta.model } : undefined,
  });

  const mainContentEl = {
    tag: 'markdown',
    content: visibleInitialText,
    element_id: CARD_ELEMENT_IDS.MAIN_CONTENT,
  };
  const interruptBtn = {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 停止回复' },
    type: 'danger',
    value: { action: 'interrupt_stream' },
    element_id: CARD_ELEMENT_IDS.INTERRUPT_BTN,
  };
  const footerNote = {
    tag: 'markdown',
    content: `<font color='grey'>${buildStatusBannerText({
      phase: 'streaming',
      runtimeProfile: opts.runtimeProfile,
    }).replace(/<[^>]+>/g, '').trim()} · 更新 ${buildLocalDatetimeWithSeconds(Date.now())}</font>`,
    element_id: CARD_ELEMENT_IDS.FOOTER_NOTE,
    text_size: 'notation',
  };

  const baseConfig = {
    update_multi: true,
    enable_forward: true,
    width_mode: 'fill',
    summary: { content: displayTitle },
    streaming_mode: true,
    streaming_config: STREAMING_CONFIG,
  };

  if (!useRich) {
    const statusNote =
      opts.runtimeProfile === 'codex' ? '⏳ Codex 处理中...' : '⏳ 生成中...';
    return {
      schema: '2.0',
      config: baseConfig,
      header,
      body: {
        direction: 'vertical',
        vertical_spacing: 'medium',
        elements: [
          {
            tag: 'markdown',
            content: '',
            element_id: CARD_ELEMENT_IDS.AUX_BEFORE,
            text_size: 'notation',
          },
          mainContentEl,
          {
            tag: 'markdown',
            content: '',
            element_id: CARD_ELEMENT_IDS.AUX_AFTER,
            text_size: 'notation',
          },
          interruptBtn,
          {
            tag: 'markdown',
            content: statusNote,
            element_id: CARD_ELEMENT_IDS.STATUS_NOTE,
            text_size: 'notation',
          },
        ],
      },
    };
  }

  // Default panel expansion for the streaming skeleton:
  //   thinking → expanded so the user can watch reasoning stream in as it arrives
  //   tools / progress → folded to keep the card compact; live status is kept
  //                       in FOOTER_NOTE to avoid duplicating it at the top.
  const panelsInit: StreamingPanelsInit = {
    runtimeProfile: opts.runtimeProfile,
    expandThinking: true,
    expandTools: false,
    expandProgress: false,
    ...(opts.panels ?? {}),
  };

  return {
    schema: '2.0',
    config: baseConfig,
    header,
    body: {
      direction: 'vertical',
      vertical_spacing: 'medium',
      elements: [
        ...buildStreamingPanels(panelsInit),
        mainContentEl,
        interruptBtn,
        footerNote,
      ],
    },
  };
}

export interface QueuedFollowUpCardInput {
  content: string;
  position: number;
  sourceJid: string;
  targetJid: string;
  messageId: string;
  expectedRunId: string;
}

/** Compact action card shown only when a message is durably queued. */
export function buildQueuedFollowUpCard(
  input: QueuedFollowUpCardInput,
): FeishuCardV2 {
  const preview = optimizeMarkdownStyle(input.content.trim(), 2).slice(0, 300);
  const actionValue = {
    sourceJid: input.sourceJid,
    targetJid: input.targetJid,
    messageId: input.messageId,
    expectedRunId: input.expectedRunId,
  };
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: false,
      width_mode: 'fill',
      summary: { content: `消息已排队 · 第 ${input.position} 位` },
    },
    header: {
      title: {
        tag: 'plain_text',
        content: `消息已排队 · 第 ${input.position} 位`,
      },
      template: 'grey',
    },
    body: {
      direction: 'vertical',
      vertical_spacing: 'small',
      elements: [
        {
          tag: 'markdown',
          content: preview || '（空消息）',
        },
        {
          tag: 'markdown',
          content:
            "<font color='grey'>默认会在当前回复结束后发送。点击立即发送，会先停止当前回复，再优先处理这条消息。</font>",
          text_size: 'notation',
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '↪ 立即发送' },
          type: 'primary',
          value: { ...actionValue, action: 'steer_queued' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '删除' },
          type: 'default',
          value: { ...actionValue, action: 'cancel_queued' },
        },
      ],
    },
  };
}

export function buildFollowUpActionResultCard(
  message: string,
  ok: boolean,
): FeishuCardV2 {
  return buildAgentReplyCard({
    status: ok ? 'done' : 'warning',
    title: ok ? '操作已完成' : '操作未执行',
    text: message,
  });
}
