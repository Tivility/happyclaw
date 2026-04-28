import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { BookOpen, Box, Loader2, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import { GroupInfo } from '../../stores/groups';
import { useAuthStore } from '../../stores/auth';
import { useChatStore } from '../../stores/chat';
import { useGroupsStore } from '../../stores/groups';

interface GroupDetailProps {
  group: GroupInfo & { jid: string };
}

export function GroupDetail({ group }: GroupDetailProps) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  const loadChatGroups = useChatStore((s) => s.loadGroups);
  const [switchingMode, setSwitchingMode] = useState(false);
  const executionMode = group.execution_mode || 'container';
  const nextExecutionMode = executionMode === 'host' ? 'container' : 'host';
  const isAdmin = user?.role === 'admin';
  const canSwitchExecutionMode = isAdmin && !group.is_home && group.jid.startsWith('web:');

  const handleSwitchExecutionMode = async () => {
    if (!canSwitchExecutionMode || switchingMode) return;
    const nextLabel = nextExecutionMode === 'host' ? '宿主机模式' : 'Docker 模式';
    if (
      nextExecutionMode === 'host' &&
      !window.confirm('切换到宿主机模式后，Agent 将直接在服务器文件系统中运行。确定继续？')
    ) {
      return;
    }

    setSwitchingMode(true);
    try {
      await api.patch<{ success: boolean }>(
        `/api/groups/${encodeURIComponent(group.jid)}`,
        { execution_mode: nextExecutionMode },
      );
      await Promise.all([loadGroups(), loadChatGroups()]);
      toast.success(`已切换为${nextLabel}`);
    } catch (err) {
      const message =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message?: unknown }).message)
          : '切换执行模式失败';
      toast.error(message);
    } finally {
      setSwitchingMode(false);
    }
  };

  const formatDate = (timestamp: string | number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="p-4 bg-background space-y-3">
      {/* JID */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">完整 JID</div>
        <code className="block text-xs font-mono bg-card px-3 py-2 rounded border border-border break-all">
          {group.jid}
        </code>
      </div>

      {/* Folder */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">文件夹</div>
        <div className="text-sm text-foreground font-medium">{group.folder}</div>
      </div>

      <div>
        <div className="text-xs text-muted-foreground mb-1">执行模式</div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div
              className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-medium ${
                executionMode === 'host'
                  ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800'
                  : 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-800'
              }`}
            >
              {executionMode === 'host' ? (
                <Monitor className="w-3.5 h-3.5" />
              ) : (
                <Box className="w-3.5 h-3.5" />
              )}
              {executionMode === 'host' ? '宿主机模式' : 'Docker 模式'}
            </div>
            {executionMode === 'host' && (
              <div className="text-xs text-muted-foreground mt-1 break-all">
                {group.custom_cwd || `data/groups/${group.folder}`}
              </div>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSwitchExecutionMode}
            disabled={!canSwitchExecutionMode || switchingMode}
            title={
              group.is_home
                ? '主工作区的执行模式由系统管理'
                : !isAdmin
                  ? '仅管理员可切换宿主机模式'
                  : !group.jid.startsWith('web:')
                    ? '仅 Web 工作区可切换执行模式'
                    : undefined
            }
          >
            {switchingMode ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : executionMode === 'host' ? (
              <Box className="w-3.5 h-3.5" />
            ) : (
              <Monitor className="w-3.5 h-3.5" />
            )}
            切换到{nextExecutionMode === 'host' ? '宿主机' : 'Docker'}
          </Button>
        </div>
      </div>

      {/* Added At */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">添加时间</div>
        <div className="text-sm text-foreground">
          {formatDate(group.added_at)}
        </div>
      </div>

      {/* Last Message */}
      {group.lastMessage && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">最后消息</div>
          <div className="text-sm text-foreground bg-card px-3 py-2 rounded border border-border line-clamp-3 break-words">
            {group.lastMessage}
          </div>
          {group.lastMessageTime && (
            <div className="text-xs text-muted-foreground mt-1">
              {formatDate(group.lastMessageTime)}
            </div>
          )}
        </div>
      )}

      {/* Quick Actions */}
      <div className="pt-2 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/settings?tab=memory&folder=${encodeURIComponent(group.folder)}`)}
        >
          <BookOpen className="w-4 h-4" />
          记忆管理
        </Button>
      </div>
    </div>
  );
}
