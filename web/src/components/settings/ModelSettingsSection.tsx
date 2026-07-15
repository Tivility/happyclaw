import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cpu, Loader2, Pencil, Plus, RefreshCw } from 'lucide-react';

import { api } from '../../api/client';
import type {
  ConversationRuntimeState,
  ProviderPool,
  ProviderPoolModelOption,
} from './types';
import { getErrorMessage } from './types';

interface PoolsResponse {
  pools: ProviderPool[];
  options: ProviderPoolModelOption[];
}

interface SystemDefaultResponse {
  default: ConversationRuntimeState;
}

const MODEL_KIND_LABEL: Record<ProviderPoolModelOption['model_kind'], string> = {
  provider_default: '默认',
  runtime_default: '默认',
  alias: '自动跟随',
  explicit_version: '固定版本',
  custom: '自定义',
};

const MODEL_KIND_HINT: Record<ProviderPoolModelOption['model_kind'], string> = {
  provider_default: '不指定具体版本，交给当前账号或 SDK 决定',
  runtime_default: '不指定具体版本，交给运行时决定',
  alias: '使用供应商维护的模型族名称，可能随 SDK 更新指向新版本',
  explicit_version: '固定到一个明确模型 ID',
  custom: '手动维护的模型 ID',
};

const STATUS_LABEL: Record<ProviderPoolModelOption['status'], string> = {
  available: '可用',
  unverified: '未验证',
  unsupported: '不支持',
  stale: '过期',
  hidden: '隐藏',
};

function optionValue(option: ProviderPoolModelOption): string {
  return `${option.provider_pool_id}::${option.model_id}::${option.model_kind}`;
}

function parseOptionValue(value: string) {
  const [providerPoolId, modelId, modelKind] = value.split('::');
  return { providerPoolId, modelId, modelKind };
}

export function ModelSettingsSection() {
  const [pools, setPools] = useState<ProviderPool[]>([]);
  const [options, setOptions] = useState<ProviderPoolModelOption[]>([]);
  const [systemDefault, setSystemDefault] = useState<ConversationRuntimeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [catalogPoolId, setCatalogPoolId] = useState('gpt');
  const [addModelId, setAddModelId] = useState('');
  const [addModelName, setAddModelName] = useState('');
  const [addModelKind, setAddModelKind] = useState<ProviderPoolModelOption['model_kind']>('explicit_version');
  const [addModelStatus, setAddModelStatus] = useState<ProviderPoolModelOption['status']>('available');
  const [editingOptionKey, setEditingOptionKey] = useState('');
  const [editModelName, setEditModelName] = useState('');
  const [editModelStatus, setEditModelStatus] = useState<ProviderPoolModelOption['status']>('available');

  const visibleOptions = useMemo(
    () => options.filter((option) => option.status !== 'hidden' && option.status !== 'unsupported'),
    [options],
  );

  const selectedCatalogPool = useMemo(
    () => pools.find((pool) => pool.provider_pool_id === catalogPoolId) || pools[0] || null,
    [catalogPoolId, pools],
  );

  const catalogOptions = useMemo(
    () =>
      options
        .filter((option) => option.provider_pool_id === catalogPoolId)
        .sort((a, b) => {
          if (a.model_id === 'default') return -1;
          if (b.model_id === 'default') return 1;
          return a.model_id.localeCompare(b.model_id);
        }),
    [catalogPoolId, options],
  );

  const selectedEditOption = useMemo(
    () =>
      editingOptionKey
        ? options.find((option) => optionValue(option) === editingOptionKey) || null
        : null,
    [editingOptionKey, options],
  );

  const optionsByPool = useMemo(
    () =>
      pools.map((pool) => ({
        pool,
        options: visibleOptions.filter(
          (option) => option.provider_pool_id === pool.provider_pool_id,
        ),
      })),
    [pools, visibleOptions],
  );

  const selectedDefaultValue = useMemo(() => {
    if (!systemDefault) return '';
    const modelId = systemDefault.selected_model || 'default';
    const match = options.find(
      (option) =>
        option.provider_pool_id === systemDefault.provider_pool_id &&
        option.model_id === modelId &&
        option.model_kind === systemDefault.model_kind,
    );
    return match ? optionValue(match) : '';
  }, [options, systemDefault]);

  const selectedDefaultOption = useMemo(
    () =>
      selectedDefaultValue
        ? options.find((option) => optionValue(option) === selectedDefaultValue) || null
        : null,
    [options, selectedDefaultValue],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const [poolData, defaultData] = await Promise.all([
        api.get<PoolsResponse>('/api/model/pools?includeAll=true'),
        api.get<SystemDefaultResponse>('/api/model/system/default'),
      ]);
      setPools(poolData.pools);
      setOptions(poolData.options);
      setSystemDefault(defaultData.default);
    } catch (err) {
      setError(getErrorMessage(err, '加载模型配置失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!pools.length) return;
    if (!pools.some((pool) => pool.provider_pool_id === catalogPoolId)) {
      setCatalogPoolId(pools[0].provider_pool_id);
    }
  }, [catalogPoolId, pools]);

  useEffect(() => {
    if (!editingOptionKey) return;
    if (!selectedEditOption) {
      setEditingOptionKey('');
      setEditModelName('');
      setEditModelStatus('available');
      return;
    }
    setEditModelName(selectedEditOption.display_name || '');
    setEditModelStatus(selectedEditOption.status);
  }, [editingOptionKey, selectedEditOption]);

  const saveSystemDefault = async (value: string) => {
    const parsed = parseOptionValue(value);
    const model = parsed.modelId === 'default' ? null : parsed.modelId;
    setBusy(true);
    setError(null);
    try {
      const data = await api.put<SystemDefaultResponse>('/api/model/system/default', {
        providerPoolId: parsed.providerPoolId,
        model,
        modelKind: parsed.modelKind,
      });
      setSystemDefault(data.default);
      setNotice('系统默认模型已更新');
    } catch (err) {
      setError(getErrorMessage(err, '保存系统默认模型失败'));
    } finally {
      setBusy(false);
    }
  };

  const addModelOption = async () => {
    const modelId = addModelId.trim();
    if (!modelId) return;
    const exists = options.some(
      (option) =>
        option.provider_pool_id === catalogPoolId &&
        option.model_id === modelId &&
        option.model_kind === addModelKind,
    );
    if (exists) {
      setError('这个目录项已经存在，请在右侧编辑区域修改。');
      setNotice(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/model/pools/${catalogPoolId}/options`, {
        modelId,
        modelKind: addModelKind,
        displayName: addModelName.trim() || null,
        status: addModelStatus,
      });
      setAddModelId('');
      setAddModelName('');
      setNotice('模型目录项已新增');
      await load();
    } catch (err) {
      setError(getErrorMessage(err, '新增模型目录项失败'));
    } finally {
      setBusy(false);
    }
  };

  const editModelOption = (option: ProviderPoolModelOption) => {
    setCatalogPoolId(option.provider_pool_id);
    setEditingOptionKey(optionValue(option));
    setEditModelName(option.display_name || '');
    setEditModelStatus(option.status);
  };

  const saveEditedModelOption = async () => {
    if (!selectedEditOption) return;
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/model/pools/${selectedEditOption.provider_pool_id}/options`, {
        modelId: selectedEditOption.model_id,
        modelKind: selectedEditOption.model_kind,
        displayName: editModelName.trim() || null,
        status: editModelStatus,
      });
      setNotice('模型目录项已更新');
      await load();
    } catch (err) {
      setError(getErrorMessage(err, '更新模型目录项失败'));
    } finally {
      setBusy(false);
    }
  };

  const renderOptionLabel = (option: ProviderPoolModelOption) => {
    const name = option.display_name || option.model_id;
    return `${name} · ${MODEL_KIND_LABEL[option.model_kind]}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {(error || notice) && (
        <div className={`rounded-md border px-3 py-2 text-sm ${error ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'}`}>
          {error || notice}
        </div>
      )}

      <section className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-start gap-2">
            <Cpu className="mt-0.5 h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">系统默认模型</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                新工作区默认继承这里；已有工作区或会话如果单独切过模型，不会被覆盖。
              </p>
            </div>
          </div>
          <button onClick={load} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="刷新">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <select
          value={selectedDefaultValue}
          disabled={busy}
          onChange={(event) => saveSystemDefault(event.target.value)}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {optionsByPool.map(({ pool, options: poolOptions }) => (
            <optgroup key={pool.provider_pool_id} label={`${pool.display_name} (${pool.provider_pool_id})`}>
              {poolOptions.map((option) => (
                <option key={optionValue(option)} value={optionValue(option)}>
                  {renderOptionLabel(option)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {selectedDefaultOption && (
          <div className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            当前：{selectedDefaultOption.display_name || selectedDefaultOption.model_id}
            {' · '}
            {selectedDefaultOption.provider_pool_id}
            {' · '}
            {MODEL_KIND_HINT[selectedDefaultOption.model_kind]}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border p-4">
        <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">模型目录</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              这里维护 /model use 可选择的模型名；账号和密钥仍在 Claude/GPT 提供商页管理。
            </p>
          </div>
          {selectedCatalogPool && (
            <div className="rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
              当前目录：{selectedCatalogPool.display_name} ({selectedCatalogPool.provider_pool_id})
            </div>
          )}
        </div>

        <label className="mb-4 block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">正在维护的模型池</span>
          <select
            value={catalogPoolId}
            onChange={(event) => {
              setCatalogPoolId(event.target.value);
              setEditingOptionKey('');
            }}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm md:max-w-xs"
          >
            {pools.map((pool) => (
              <option key={pool.provider_pool_id} value={pool.provider_pool_id}>
                {pool.display_name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-lg border border-border bg-background/50 p-3">
            <div className="mb-3">
              <h3 className="text-xs font-semibold text-foreground">新增模型</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                模型 ID 是实际用于 /model use 和 SDK 调用的值；显示名只是页面上的可读标签。
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">模型 ID</span>
                <input
                  value={addModelId}
                  onChange={(event) => setAddModelId(event.target.value)}
                  placeholder={
                    selectedCatalogPool?.provider_family === 'gpt'
                      ? 'gpt-5.6-sol'
                      : selectedCatalogPool?.provider_family === 'grok'
                        ? 'grok-4.5'
                        : 'claude-opus-4-8[1m]'
                  }
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">显示名</span>
                <input
                  value={addModelName}
                  onChange={(event) => setAddModelName(event.target.value)}
                  placeholder="可选，例如 GPT 5.5"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">模型模式</span>
                <select value={addModelKind} onChange={(event) => setAddModelKind(event.target.value as ProviderPoolModelOption['model_kind'])} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="explicit_version">固定版本</option>
                  <option value="alias">自动跟随</option>
                  <option value="custom">自定义</option>
                  <option value="provider_default">默认</option>
                </select>
                <div className="text-xs text-muted-foreground">
                  {MODEL_KIND_HINT[addModelKind]}
                </div>
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">状态</span>
                <select value={addModelStatus} onChange={(event) => setAddModelStatus(event.target.value as ProviderPoolModelOption['status'])} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="available">可用</option>
                  <option value="unverified">未验证</option>
                  <option value="hidden">隐藏</option>
                  <option value="unsupported">不支持</option>
                </select>
              </label>
            </div>
            <button disabled={busy || !addModelId.trim()} onClick={addModelOption} className="mt-3 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50">
              <Plus className="h-4 w-4" /> 新增
            </button>
          </div>

          <div className="rounded-lg border border-border bg-background/50 p-3">
            <div className="mb-3">
              <h3 className="text-xs font-semibold text-foreground">编辑已有模型</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                从下方列表点编辑。模型 ID 和模型模式是目录主键；需要改名时新增一条，再把旧项设为隐藏。
              </p>
            </div>
            {selectedEditOption ? (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">模型 ID</span>
                    <div className="flex h-10 items-center rounded-md border border-border bg-muted/40 px-3 font-mono text-sm text-foreground">
                      {selectedEditOption.model_id}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">模型模式</span>
                    <div className="flex h-10 items-center rounded-md border border-border bg-muted/40 px-3 text-sm text-foreground">
                      {MODEL_KIND_LABEL[selectedEditOption.model_kind]}
                    </div>
                  </div>
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">显示名</span>
                    <input
                      value={editModelName}
                      onChange={(event) => setEditModelName(event.target.value)}
                      placeholder="留空则显示模型 ID"
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">状态</span>
                    <select value={editModelStatus} onChange={(event) => setEditModelStatus(event.target.value as ProviderPoolModelOption['status'])} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                      <option value="available">可用</option>
                      <option value="unverified">未验证</option>
                      <option value="hidden">隐藏</option>
                      <option value="unsupported">不支持</option>
                    </select>
                  </label>
                </div>
                <div className="flex gap-2">
                  <button disabled={busy} onClick={saveEditedModelOption} className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50">
                    保存编辑
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setEditingOptionKey('')}
                    className="h-10 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex min-h-40 items-center justify-center rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                还没有选中目录项。点击下方列表右侧的编辑按钮后，在这里修改显示名和状态。
              </div>
            )}
          </div>
        </div>

        <div className="mt-4">
          <h3 className="text-xs font-semibold text-foreground">当前目录项</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            这些模型会进入默认模型下拉和 /model list；点击编辑会进入右侧编辑区域。
          </p>
        </div>
        <div className="mt-2 grid gap-2">
          {catalogOptions.length === 0 && (
            <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              这个模型池还没有目录项。
            </div>
          )}
          {catalogOptions.map((option) => (
            <div key={optionValue(option)} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-foreground">{option.model_id}</div>
                {option.display_name && option.display_name !== option.model_id && (
                  <div className="truncate text-xs text-muted-foreground">{option.display_name}</div>
                )}
              </div>
              <div className="ml-3 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <span>{MODEL_KIND_LABEL[option.model_kind]}</span>
                <span className="rounded-full bg-muted px-2 py-0.5">{STATUS_LABEL[option.status]}</span>
                <button
                  type="button"
                  onClick={() => editModelOption(option)}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="编辑目录项"
                  aria-label={`编辑 ${option.model_id}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
}
