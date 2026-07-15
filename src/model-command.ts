import {
  getProviderPool,
  getProviderPools,
  listProviderPoolModelOptions,
} from './db.js';
import { getEnabledProvidersForPool } from './runtime-config.js';
import type {
  ConversationRuntimeState,
  ModelBinding,
  ModelSelectionKind,
  ProviderPoolModelOption,
} from './types.js';

export function formatModelLabel(model: string | null | undefined): string {
  return model && model.trim() ? model : 'default';
}

export function formatModelKindLabel(
  kind: ModelSelectionKind | ProviderPoolModelOption['model_kind'],
): string {
  switch (kind) {
    case 'provider_default':
    case 'runtime_default':
      return '默认';
    case 'alias':
      return '自动跟随';
    case 'explicit_version':
      return '固定版本';
    case 'custom':
      return '自定义';
    default:
      return String(kind);
  }
}

export function formatModelStatusLabel(
  status: ProviderPoolModelOption['status'],
): string {
  switch (status) {
    case 'available':
      return '可用';
    case 'unverified':
      return '未验证';
    case 'unsupported':
      return '不支持';
    case 'stale':
      return '待更新';
    case 'hidden':
      return '隐藏';
    default:
      return String(status);
  }
}

export function commandParts(content: string): string[] {
  return content.trim().split(/\s+/).filter(Boolean);
}

export function shouldIncludeAllModelOptions(args: string[]): boolean {
  return args.some((arg) => {
    const normalized = arg.toLowerCase();
    return normalized === '--all' || normalized === 'all';
  });
}

function metadataFromOption(
  option?: ProviderPoolModelOption,
): Record<string, unknown> | null {
  if (!option?.metadata_json) return null;
  try {
    return JSON.parse(option.metadata_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolvedModelFromOption(option?: ProviderPoolModelOption): string | null {
  const metadata = metadataFromOption(option);
  const resolved = metadata?.resolved_model ?? metadata?.resolvedModel;
  return typeof resolved === 'string' && resolved.trim()
    ? resolved.trim()
    : null;
}

function metadataAliasesFromOption(option: ProviderPoolModelOption): string[] {
  const metadata = metadataFromOption(option);
  const aliases = metadata?.aliases;
  if (!Array.isArray(aliases)) return [];
  return aliases
    .filter((alias): alias is string => typeof alias === 'string')
    .map((alias) => alias.trim())
    .filter(Boolean);
}

function dedupeAliases(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function shortClaudeModelName(modelId: string): string | null {
  const stripped = modelId.replace(/^claude-/i, '');
  const aliasMatch = stripped.match(/^(fable|opus|sonnet|haiku)$/i);
  if (aliasMatch) return aliasMatch[1].toLowerCase();

  const versionMatch = stripped.match(
    /^(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i,
  );
  if (!versionMatch) return null;
  const family = versionMatch[1].toLowerCase();
  const major = versionMatch[2];
  const minor = versionMatch[3];
  return minor ? `${family}-${major}.${minor}` : `${family}-${major}`;
}

function derivedModelAliases(option: ProviderPoolModelOption): string[] {
  const suffixMatch = option.model_id.match(/\[(\d+)m\]$/i);
  const baseModelId = option.model_id.replace(/\[\d+m\]$/i, '');
  const shortName = shortClaudeModelName(baseModelId);
  if (!shortName) return [];

  const aliases: string[] = [];
  if (suffixMatch) {
    aliases.push(`${shortName}-${suffixMatch[1].toLowerCase()}m`);
    aliases.push(`${shortName}[${suffixMatch[1].toLowerCase()}m]`);
  } else {
    aliases.push(shortName);
  }

  return aliases.flatMap((alias) => {
    const noDot = alias.replace(/\.(\d+)/, '-$1');
    return noDot === alias ? [alias] : [alias, noDot];
  });
}

function modelSpecAliases(option: ProviderPoolModelOption): string[] {
  return dedupeAliases([
    ...metadataAliasesFromOption(option),
    ...derivedModelAliases(option),
  ]).filter(
    (alias) => alias.toLowerCase() !== option.model_id.toLowerCase(),
  );
}

function findModelOptionMatches(
  options: ProviderPoolModelOption[],
  modelSpec: string,
): ProviderPoolModelOption[] {
  const normalized = modelSpec.toLowerCase();
  const exactMatches = options.filter(
    (item) => item.model_id.toLowerCase() === normalized,
  );
  if (exactMatches.length > 0) return exactMatches;
  return options.filter((item) =>
    modelSpecAliases(item).some((alias) => alias.toLowerCase() === normalized),
  );
}

function shouldShowInDefaultModelList(option: ProviderPoolModelOption): boolean {
  return option.status !== 'hidden' && option.status !== 'unsupported';
}

function buildModelUseCommand(
  option: ProviderPoolModelOption,
  options: ProviderPoolModelOption[],
): string {
  if (option.model_id === 'default') {
    return `/model use ${option.provider_pool_id} default`;
  }
  const sameModelCount = options.filter(
    (item) =>
      item.model_id.toLowerCase() === option.model_id.toLowerCase() &&
      item.status !== 'hidden' &&
      item.status !== 'unsupported',
  ).length;
  if (sameModelCount > 1) {
    return `/model use ${option.provider_pool_id} ${option.model_id}`;
  }
  return `/model use ${option.model_id}`;
}

function formatModelOptionLine(
  option: ProviderPoolModelOption,
  options: ProviderPoolModelOption[],
): string {
  const displayName = option.display_name || option.model_id;
  const command = buildModelUseCommand(option, options);
  const details = [
    displayName,
    formatModelKindLabel(option.model_kind),
    formatModelStatusLabel(option.status),
  ].join(' · ');
  const shortAlias = modelSpecAliases(option)[0];
  return shortAlias
    ? `  ${command}\n    ${details}\n    短写：/model use ${shortAlias}`
    : `  ${command}\n    ${details}`;
}

export function parseModelBindingFromArgs(
  args: string[],
): { binding?: ModelBinding; error?: string } {
  if (args.length === 0) {
    return {
      error:
        '用法：/model use <claude|gpt|grok> [model]\n例如：/model use gpt-5.6、/model use opus-4.8-1m、/model use grok-4.5 或 /model use claude claude-opus-4-8[1m]',
    };
  }

  const pools = getProviderPools().filter((pool) => pool.enabled);
  const visibleOptions = listProviderPoolModelOptions(undefined, false).filter(
    (option) => option.status !== 'hidden',
  );
  const first = args[0].toLowerCase();
  const pool = pools.find(
    (item) =>
      item.provider_pool_id.toLowerCase() === first ||
      item.display_name.toLowerCase() === first,
  );

  let providerPoolId: string;
  let selectedModel: string | null = null;
  let modelKind: ModelSelectionKind = 'provider_default';
  let resolvedModel: string | null = null;

  if (pool) {
    providerPoolId = pool.provider_pool_id;
    const modelSpec = args.slice(1).join(' ').trim();
    if (modelSpec && modelSpec.toLowerCase() !== 'default') {
      const option = findModelOptionMatches(
        visibleOptions.filter((item) => item.provider_pool_id === providerPoolId),
        modelSpec,
      )[0];
      if (!option) {
        return {
          error: `模型 ${modelSpec} 未配置在模型池 ${providerPoolId} 中。请先用 /model list 查看可用模型。`,
        };
      }
      if (option.status === 'unsupported') {
        return { error: `模型 ${modelSpec} 当前标记为不可用。` };
      }
      selectedModel = option.model_id;
      modelKind = option.model_kind;
      resolvedModel = resolvedModelFromOption(option);
    }
  } else {
    const modelSpec = args.join(' ').trim();
    if (modelSpec.toLowerCase() === 'default') {
      return {
        error:
          '请指定模型池：/model use claude default 或 /model use gpt default 或 /model use grok default',
      };
    }
    const matches = findModelOptionMatches(visibleOptions, modelSpec);
    if (matches.length === 0) {
      return {
        error: `未找到模型 ${modelSpec}。请先用 /model list 查看可用模型。`,
      };
    }
    const enabledMatches = matches.filter((item) =>
      pools.some(
        (poolItem) => poolItem.provider_pool_id === item.provider_pool_id,
      ),
    );
    if (enabledMatches.length !== 1) {
      return {
        error:
          enabledMatches.length > 1
            ? `模型 ${modelSpec} 在多个模型池中存在，请写成 /model use <模型池> ${modelSpec}`
            : `模型 ${modelSpec} 所在模型池未启用。`,
      };
    }
    const option = enabledMatches[0];
    if (option.status === 'unsupported') {
      return { error: `模型 ${modelSpec} 当前标记为不可用。` };
    }
    providerPoolId = option.provider_pool_id;
    selectedModel = option.model_id;
    modelKind = option.model_kind;
    resolvedModel = resolvedModelFromOption(option);
  }

  const resolvedPool = getProviderPool(providerPoolId);
  if (!resolvedPool) return { error: `未知模型池：${providerPoolId}` };
  if (getEnabledProvidersForPool(providerPoolId).length === 0) {
    return {
      error: `模型池 ${providerPoolId} 没有启用的鉴权供应商，请先配置对应账号池。`,
    };
  }

  return {
    binding: {
      runtime: resolvedPool.runtime,
      provider_family: resolvedPool.provider_family,
      provider_pool_id: resolvedPool.provider_pool_id,
      selected_model: selectedModel,
      model_kind: modelKind,
      resolved_model: resolvedModel,
    },
  };
}

export function formatModelList(includeAll = false): string {
  const pools = getProviderPools();
  const options = listProviderPoolModelOptions(undefined, includeAll);
  const lines = [
    includeAll
      ? '模型目录（含隐藏/不可用）：'
      : '可用模型（直接复制下面的切换命令）：',
  ];
  for (const pool of pools) {
    const poolOptions = options.filter(
      (item) => item.provider_pool_id === pool.provider_pool_id,
    );
    lines.push(`\n${pool.display_name} (${pool.provider_pool_id})`);
    if (poolOptions.length === 0) {
      lines.push('  - 暂无模型选项');
      continue;
    }
    for (const option of poolOptions) {
      if (!includeAll && !shouldShowInDefaultModelList(option)) continue;
      lines.push(formatModelOptionLine(option, options));
    }
  }
  lines.push('\n说明：唯一模型可直接用短命令；default 或重名模型会自动带上模型池。展示名只用于阅读。');
  lines.push('查看完整目录：/model list --all');
  return lines.join('\n');
}

export function formatRuntimeState(
  state: ConversationRuntimeState,
  scopeName: string,
): string {
  const pool = getProviderPool(state.provider_pool_id);
  return [
    `当前模型：${formatModelLabel(state.selected_model)}`,
    `模型池：${pool?.display_name || state.provider_pool_id} (${state.provider_pool_id})`,
    `运行时：${state.runtime}`,
    `模型模式：${formatModelKindLabel(state.model_kind)}`,
    `作用域：${scopeName}`,
    `来源：${state.binding_source}`,
  ].join('\n');
}
