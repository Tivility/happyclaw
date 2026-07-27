import { useEffect, useState } from 'react';
import { useTasksStore } from '../stores/tasks';
import { useAuthStore } from '../stores/auth';
import { useGroupsStore } from '../stores/groups';
import { TaskCard } from '../components/tasks/TaskCard';
import { CreateTaskForm } from '../components/tasks/CreateTaskForm';
import { Plus, RefreshCw, Clock, X } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';

export function TasksPage() {
  const {
    tasks,
    loading,
    error,
    runningTaskIds,
    loadTasks,
    createTask,
    updateTaskStatus,
    deleteTask,
    restoreTask,
    runTaskNow,
    stopTaskRun,
  } = useTasksStore();
  const { user } = useAuthStore();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // Poll while any task is parsing/running so UI updates when done
  const hasParsing = tasks.some((t) => t.status === 'parsing');
  const liveRunStatuses = new Set([
    'queued',
    'running',
    'recovering',
    'retry_wait',
  ]);
  const hasRunning =
    runningTaskIds.size > 0 ||
    tasks.some(
      (task) =>
        task.current_run && liveRunStatuses.has(task.current_run.status),
    );
  const hasNotificationWork = tasks.some(
    (task) =>
      task.last_run_summary?.notification_status === 'pending' ||
      !!task.last_run_summary?.notification_available_at,
  );
  const liveRunCount = new Set([
    ...runningTaskIds,
    ...tasks
      .filter(
        (task) =>
          task.current_run && liveRunStatuses.has(task.current_run.status),
      )
      .map((task) => task.id),
  ]).size;
  useEffect(() => {
    if (!hasParsing && !hasRunning && !hasNotificationWork) return;
    const interval = setInterval(loadTasks, 3000);
    return () => clearInterval(interval);
  }, [hasParsing, hasRunning, hasNotificationWork, loadTasks]);

  const handleCreateTask = async (data: {
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    executionType: 'agent' | 'script';
    executionMode?: 'host' | 'container';
    scriptCommand: string;
    notifyChannels: string[] | null;
    chatJid?: string;
    contextMode?: 'group' | 'isolated';
  }) => {
    await createTask(
      data.prompt,
      data.scheduleType,
      data.scheduleValue,
      data.executionType,
      data.executionMode,
      data.scriptCommand,
      data.notifyChannels,
      data.chatJid,
      data.contextMode,
    );
    // Only close the form when the store reports no error — failures surface
    // as a toast inside CreateTaskForm and the form stays open for retry.
    if (!useTasksStore.getState().error) {
      setShowCreateForm(false);
    }
  };

  const handlePause = async (id: string) => {
    if (
      confirm(
        '暂停后续计划？\n\n当前正在运行的任务会继续执行。如需终止，请使用“停止当前运行”。',
      )
    ) {
      await updateTaskStatus(id, 'paused');
    }
  };

  const handleResume = async (id: string) => {
    const task = tasks.find((candidate) => candidate.id === id);
    const message =
      task?.schedule_type === 'once'
        ? `启用这个一次性任务？\n\n任务会在 ${new Date(task.schedule_value).toLocaleString('zh-CN')} 执行；如果该时间已过，请先修改为未来时间。`
        : '确定要恢复此任务吗？';
    if (confirm(message)) {
      await updateTaskStatus(id, 'active');
    }
  };

  const handleDelete = async (id: string) => {
    if (
      confirm(
        '删除任务？\n\n任务将移入“已删除”，不会再触发；历史运行记录仍会保留。',
      )
    ) {
      await deleteTask(id);
      useGroupsStore.getState().loadGroups();
    }
  };

  const handleStopRun = async (runId: string | number) => {
    if (
      confirm(
        '停止当前运行？\n\n本次运行会被取消，后续计划不受影响。已经完成的外部操作无法撤销。',
      )
    ) {
      await stopTaskRun(runId);
    }
  };

  const handleRestore = async (id: string) => {
    if (
      confirm(
        '恢复这个任务？\n\n任务会恢复为暂停状态，不会立即触发。一次性任务若已过原定时间，需要先修改为未来时间再启用。',
      )
    ) {
      await restoreTask(id);
    }
  };

  const deletedTasks = tasks.filter((t) => !!t.deleted_at);
  const liveTasks = tasks.filter((t) => !t.deleted_at);
  const enabledTasks = liveTasks.filter((t) => t.status === 'active');
  const pausedTasks = liveTasks.filter((t) => t.status === 'paused');
  const otherTasks = tasks.filter(
    (t) => !t.deleted_at && t.status !== 'active' && t.status !== 'paused',
  );
  const retryingCount = liveTasks.filter(
    (task) => task.current_run?.status === 'retry_wait',
  ).length;

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <PageHeader
          title="定时任务管理"
          subtitle={`共 ${liveTasks.length} 个任务 · ${enabledTasks.length} 已启用 · ${liveRunCount} 执行中${retryingCount > 0 ? ` · ${retryingCount} 等待重试` : ''} · ${pausedTasks.length} 已暂停`}
          className="mb-6"
          actions={
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <Button variant="outline" onClick={loadTasks} disabled={loading}>
                <RefreshCw
                  size={18}
                  className={loading ? 'animate-spin' : ''}
                />
                刷新
              </Button>
              <Button onClick={() => setShowCreateForm(true)}>
                <Plus size={18} />
                创建任务
              </Button>
            </div>
          }
        />

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-error-bg border border-error/20 flex items-center justify-between">
            <span className="text-sm text-error">{error}</span>
            <button
              onClick={() => useTasksStore.setState({ error: null })}
              className="p-1 text-error hover:text-error rounded transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {loading && tasks.length === 0 ? (
          <SkeletonCardList count={4} />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="还没有创建任何定时任务"
            description="定时任务会在所属工作区内自动执行，默认使用独立任务会话，不影响主会话上下文。"
            action={
              <Button onClick={() => setShowCreateForm(true)}>
                <Plus size={18} />
                创建第一个任务
              </Button>
            }
          />
        ) : (
          <div className="space-y-6">
            {enabledTasks.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-foreground mb-3">
                  已启用
                </h2>
                <div className="space-y-3">
                  {enabledTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      isRunning={runningTaskIds.has(task.id)}
                      onPause={handlePause}
                      onResume={handleResume}
                      onDelete={handleDelete}
                      onRunNow={runTaskNow}
                      onStopRun={handleStopRun}
                    />
                  ))}
                </div>
              </div>
            )}

            {pausedTasks.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-foreground mb-3">
                  已暂停
                </h2>
                <div className="space-y-3">
                  {pausedTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      isRunning={runningTaskIds.has(task.id)}
                      onPause={handlePause}
                      onResume={handleResume}
                      onDelete={handleDelete}
                      onRunNow={runTaskNow}
                      onStopRun={handleStopRun}
                    />
                  ))}
                </div>
              </div>
            )}

            {otherTasks.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-foreground mb-3">
                  其他
                </h2>
                <div className="space-y-3">
                  {otherTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      isRunning={runningTaskIds.has(task.id)}
                      onPause={handlePause}
                      onResume={handleResume}
                      onDelete={handleDelete}
                      onRunNow={runTaskNow}
                      onStopRun={handleStopRun}
                    />
                  ))}
                </div>
              </div>
            )}

            {deletedTasks.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-muted-foreground mb-3">
                  已删除
                </h2>
                <div className="space-y-3 opacity-80">
                  {deletedTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      isRunning={false}
                      onPause={handlePause}
                      onResume={handleResume}
                      onDelete={handleDelete}
                      onRestore={handleRestore}
                      onStopRun={handleStopRun}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {showCreateForm && (
        <CreateTaskForm
          onSubmit={handleCreateTask}
          onClose={() => {
            setShowCreateForm(false);
            loadTasks();
          }}
          isAdmin={isAdmin}
        />
      )}
    </div>
  );
}
