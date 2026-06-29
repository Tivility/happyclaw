import { useCallback, useEffect, useState } from 'react';
import {
  Bot,
  Edit3,
  ExternalLink,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api } from '../../api/client';
import type { UnifiedProviderPublic } from './types';
import { getErrorMessage } from './types';

interface GrokProviderSectionProps {
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

interface GrokProviderEditorProps {
  open: boolean;
  provider: UnifiedProviderPublic | null;
  onSave: () => void;
  onCancel: () => void;
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

interface GrokOAuthFlowState {
  state: string;
  authorizeUrl: string;
  deviceCode: string;
  expiresAt: number;
}

function authLabel(provider: UnifiedProviderPublic): string {
  if (provider.hasGrokAuthJson) return 'Grok OAuth auth.json';
  return '未配置凭据';
}

function GrokProviderEditor({
  open,
  provider,
  onSave,
  onCancel,
  setNotice,
  setError,
}: GrokProviderEditorProps) {
  const isCreate = provider === null;
  const [name, setName] = useState('');
  const [weight, setWeight] = useState(1);
  const [grokAuthJson, setGrokAuthJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthCompleting, setOauthCompleting] = useState(false);
  const [oauthFlow, setOauthFlow] = useState<GrokOAuthFlowState | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(provider?.name || '官方 Grok');
    setWeight(provider?.weight || 1);
    setGrokAuthJson('');
    setOauthLoading(false);
    setOauthCompleting(false);
    setOauthFlow(null);
  }, [open, provider]);

  const cancelOAuthFlow = useCallback(async () => {
    if (!oauthFlow) return;
    const state = oauthFlow.state;
    setOauthFlow(null);
    await api.post('/api/config/grok/oauth/cancel', { state }).catch(() => {});
  }, [oauthFlow]);

  const handleOAuthStart = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('请填写提供商名称');
      return;
    }

    if (oauthFlow) {
      await cancelOAuthFlow();
    }

    setOauthLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: trimmedName,
        weight,
      };
      if (!isCreate && provider) {
        body.targetProviderId = provider.id;
      }
      const data = await api.post<GrokOAuthFlowState>(
        '/api/config/grok/oauth/start',
        body,
        15000,
      );
      setOauthFlow(data);
      window.open(data.authorizeUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(getErrorMessage(err, 'Grok OAuth 登录启动失败'));
    } finally {
      setOauthLoading(false);
    }
  }, [cancelOAuthFlow, isCreate, name, oauthFlow, provider, setError, weight]);

  const handleOAuthComplete = useCallback(async () => {
    if (!oauthFlow) return;
    setOauthCompleting(true);
    setError(null);
    try {
      await api.post<{ provider: UnifiedProviderPublic }>(
        '/api/config/grok/oauth/complete',
        { state: oauthFlow.state },
        30000,
      );
      setOauthFlow(null);
      setNotice(isCreate ? 'Grok OAuth 登录成功，Grok 提供商已创建。' : 'Grok OAuth 登录成功，凭据已更新。');
      onSave();
    } catch (err) {
      setError(getErrorMessage(err, 'Grok OAuth 登录尚未完成'));
    } finally {
      setOauthCompleting(false);
    }
  }, [isCreate, oauthFlow, onSave, setError, setNotice]);

  const handleCopyDeviceCode = useCallback(async () => {
    if (!oauthFlow?.deviceCode) return;
    try {
      await navigator.clipboard.writeText(oauthFlow.deviceCode);
      setNotice('一次性 code 已复制。');
    } catch {
      setError('复制失败，请手动选中 code 复制。');
    }
  }, [oauthFlow, setError, setNotice]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('请填写提供商名称');
      return;
    }
    if (isCreate && !grokAuthJson.trim()) {
      setError('请先使用一键登录 Grok，或粘贴 Grok auth.json 内容');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (isCreate) {
        await api.post(
          '/api/config/grok/providers',
          {
            name: trimmedName,
            authMode: 'grok_oauth',
            grokAuthJson: grokAuthJson.trim(),
            enabled: true,
            weight,
          },
          30000,
        );
        setNotice('Grok 提供商已创建。');
      } else {
        await api.patch(`/api/config/grok/providers/${provider.id}`, {
          name: trimmedName,
          weight,
        });

        if (grokAuthJson.trim()) {
          await api.put(
            `/api/config/grok/providers/${provider.id}/secrets`,
            { grokAuthJson: grokAuthJson.trim() },
          );
        }
        setNotice('Grok 提供商配置已保存。');
      }
      onSave();
    } catch (err) {
      setError(getErrorMessage(err, isCreate ? '创建 Grok 提供商失败' : '保存 Grok 提供商失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !saving && !oauthCompleting) {
          void cancelOAuthFlow();
          onCancel();
        }
      }}
    >
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isCreate ? '添加官方 Grok 提供商' : `编辑官方 Grok 提供商：${provider?.name}`}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">名称</label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={saving}
              placeholder="如：官方 Grok"
            />
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-2">提供商类型</label>
            <div className="inline-flex rounded-lg border border-border p-1 bg-muted">
              <button
                type="button"
                className="px-3 py-1.5 text-sm rounded-md bg-background text-primary shadow-sm cursor-default"
              >
                官方 Grok
              </button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              当前 Grok 账号池仅接入 xAI 官方 Grok CLI OAuth（grok login）。
            </p>
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">权重</label>
            <Input
              type="number"
              min={1}
              max={100}
              value={weight}
              onChange={(event) => setWeight(Math.max(1, Math.min(100, Number(event.target.value) || 1)))}
              disabled={saving}
            />
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-4 space-y-3 dark:border-teal-900 dark:bg-teal-950/20">
              <div className="text-sm font-medium text-foreground">一键登录 Grok（推荐）</div>
              <div className="text-xs text-muted-foreground">
                点击按钮后会打开 xAI 授权页面，把这里显示的一次性 code 填进去；完成后回到这里确认。
              </div>

              {!isCreate && provider?.hasGrokAuthJson && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50/50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
                  当前已配置 Grok OAuth auth.json，可重新登录覆盖。
                </div>
              )}

              {!oauthFlow ? (
                <Button onClick={handleOAuthStart} disabled={saving || oauthLoading}>
                  {oauthLoading ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                  {!isCreate && provider?.hasGrokAuthJson ? '重新登录 Grok' : '一键登录 Grok'}
                </Button>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                    授权页面已打开。一次性 code 会在 {new Date(oauthFlow.expiresAt).toLocaleTimeString('zh-CN')} 过期。
                  </div>
                  {oauthFlow.deviceCode && (
                    <div className="flex flex-col sm:flex-row gap-2">
                      <div className="flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-lg text-foreground">
                        {oauthFlow.deviceCode}
                      </div>
                      <Button variant="outline" onClick={handleCopyDeviceCode} disabled={oauthCompleting}>
                        复制 code
                      </Button>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={handleOAuthComplete} disabled={oauthCompleting}>
                      {oauthCompleting && <Loader2 className="size-4 animate-spin" />}
                      我已完成授权
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => window.open(oauthFlow.authorizeUrl, '_blank', 'noopener,noreferrer')}
                      disabled={oauthCompleting}
                    >
                      <ExternalLink className="size-4" />
                      重新打开
                    </Button>
                    <Button variant="ghost" onClick={() => void cancelOAuthFlow()} disabled={oauthCompleting}>
                      取消
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                Grok auth.json{isCreate ? '（手动兜底）' : '（留空则不修改）'}
              </label>
              <Textarea
                value={grokAuthJson}
                onChange={(event) => setGrokAuthJson(event.target.value)}
                disabled={saving || oauthCompleting}
                placeholder="也可以手动粘贴 grok login 生成的 auth.json 内容"
                className="min-h-32 font-mono text-xs"
              />
            </div>
          </div>

          {!isCreate && (
            <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              当前凭据：{provider ? authLabel(provider) : ''}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                void cancelOAuthFlow();
                onCancel();
              }}
              disabled={saving || oauthCompleting}
            >
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving || oauthCompleting}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              保存
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function GrokProviderSection({ setNotice, setError }: GrokProviderSectionProps) {
  const [providers, setProviders] = useState<UnifiedProviderPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<UnifiedProviderPublic | null>(null);
  const [pendingDeleteProvider, setPendingDeleteProvider] = useState<UnifiedProviderPublic | null>(null);

  const notifyNotice = useCallback((message: string | null) => {
    setLocalNotice(message);
    if (message) setLocalError(null);
    setNotice(message);
  }, [setNotice]);

  const notifyError = useCallback((message: string | null) => {
    setLocalError(message);
    if (message) setLocalNotice(null);
    setError(message);
  }, [setError]);

  const load = useCallback(async () => {
    try {
      const providersData = await api.get<{ providers: UnifiedProviderPublic[] }>(
        '/api/config/grok/providers',
      );
      setProviders(providersData.providers);
    } catch (err) {
      notifyError(getErrorMessage(err, '加载 Grok 提供商失败'));
    } finally {
      setLoading(false);
    }
  }, [notifyError]);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = async (provider: UnifiedProviderPublic) => {
    setBusyId(provider.id);
    notifyError(null);
    try {
      await api.patch(`/api/config/grok/providers/${provider.id}`, {
        enabled: !provider.enabled,
      });
      notifyNotice(provider.enabled ? `已禁用「${provider.name}」` : `已启用「${provider.name}」`);
      await load();
    } catch (err) {
      notifyError(getErrorMessage(err, '切换 Grok 提供商状态失败'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!pendingDeleteProvider) return;
    const provider = pendingDeleteProvider;
    setPendingDeleteProvider(null);
    setBusyId(provider.id);
    notifyError(null);
    try {
      await api.delete(`/api/config/grok/providers/${provider.id}`);
      notifyNotice(`已删除 Grok 提供商「${provider.name}」`);
      await load();
    } catch (err) {
      notifyError(getErrorMessage(err, '删除 Grok 提供商失败'));
    } finally {
      setBusyId(null);
    }
  };

  const handleEditorSave = () => {
    setEditorOpen(false);
    setEditingProvider(null);
    load();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {(localError || localNotice) && (
        <div className={`rounded-md border px-3 py-2 text-sm ${localError ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'}`}>
          {localError || localNotice}
        </div>
      )}

      <div className="rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/50">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">官方 Grok 账号池</div>
            </div>
            <span className="text-xs text-muted-foreground">{providers.length} 个提供商</span>
          </div>
        </div>

        {providers.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            暂无官方 Grok 提供商，请点击下方按钮添加。
          </div>
        ) : (
          <div className="divide-y divide-border">
            {providers.map((provider) => {
              const busy = busyId === provider.id;
              return (
                <div
                  key={provider.id}
                  className={`px-4 py-3 transition-colors ${
                    !provider.enabled ? 'bg-muted/50 opacity-60' : ''
                  }`}
                >
                  <div className="flex items-center gap-2 justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">
                          {provider.name}
                        </span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">
                          官方 Grok
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                        <span>{authLabel(provider)}</span>
                        <span>generation {provider.authProfileGeneration}</span>
                        <span>weight {provider.weight}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <Switch
                        checked={provider.enabled}
                        disabled={busyId !== null}
                        onCheckedChange={() => handleToggle(provider)}
                        aria-label={provider.enabled ? '禁用 Grok 提供商' : '启用 Grok 提供商'}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingProvider(provider);
                          setEditorOpen(true);
                        }}
                        disabled={busyId !== null}
                        className="h-7 px-2 text-xs"
                      >
                        <Edit3 className="size-3.5" />
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setPendingDeleteProvider(provider)}
                        disabled={busyId !== null}
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-red-600"
                      >
                        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex justify-start">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setEditingProvider(null);
            setEditorOpen(true);
          }}
          disabled={busyId !== null}
        >
          <Plus className="size-4" />
          添加官方 Grok 提供商
        </Button>
      </div>

      <GrokProviderEditor
        open={editorOpen}
        provider={editingProvider}
        onSave={handleEditorSave}
        onCancel={() => {
          setEditorOpen(false);
          setEditingProvider(null);
        }}
        setNotice={notifyNotice}
        setError={notifyError}
      />

      <ConfirmDialog
        open={pendingDeleteProvider !== null}
        onClose={() => setPendingDeleteProvider(null)}
        onConfirm={handleDeleteConfirm}
        title="删除官方 Grok 提供商"
        message={pendingDeleteProvider ? `确认删除官方 Grok 提供商「${pendingDeleteProvider.name}」？` : '确认删除该官方 Grok 提供商？'}
        confirmText="确认删除"
        confirmVariant="danger"
        loading={busyId !== null}
      />
    </div>
  );
}
