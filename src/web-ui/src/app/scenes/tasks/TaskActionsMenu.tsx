/**
 * TaskActionsMenu — 工作台任务行操作菜单（重命名 / 归档 / 删除）。
 *
 * 任务卡本身只有「打开」，这里补可维护动作：重命名标题、归档（从列表收起，
 * 可在「任务」工作台的已归档视图恢复）、删除（连卡片一起移除，引擎会话保留）。
 */
import React, { useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import {
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  InputDialog,
} from '@/component-library';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { dshSession } from '@/infrastructure/api/service-api/DshAPI';
import { useTodoStore } from '@/tools/todo/store/todoStore';
import type { TodoTask } from '@/tools/todo/api/types';
import { releaseWorktree } from '../projects/projectGit';
import './TaskActionsMenu.scss';

export interface TaskActionsMenuProps {
  task: TodoTask;
  /** 归档状态变化（宿主据此退出当前会话）。 */
  onArchived?: (archived: boolean) => void;
  /** 删除完成（宿主据此退出当前会话）。 */
  onDeleted?: () => void;
}

export const TaskActionsMenu: React.FC<TaskActionsMenuProps> = ({
  task,
  onArchived,
  onDeleted,
}) => {
  const { t } = useI18n('common');
  const updateTask = useTodoStore((s) => s.updateTask);
  const deleteTask = useTodoStore((s) => s.deleteTask);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** 菜单点选后要打开的对话框：等菜单层卸载完再开（见 onOpenChange 注释）。 */
  const pendingDialogRef = useRef<'rename' | 'delete' | null>(null);
  const archived = Boolean(task.archivedAt);

  const handleArchive = (): void => {
    updateTask(task.id, { archivedAt: archived ? null : Date.now() });
    onArchived?.(!archived);
  };

  /**
   * 菜单先关、对话框后开。
   *
   * Radix 的菜单与对话框都用 DismissableLayer 锁 body 的 pointer-events：
   * 两层同时在场时（菜单里点「删除」立刻开对话框），关闭时恢复条件
   * `layersWithOutsidePointerEventsDisabled.size === 1` 不成立，body 会一直
   * `pointer-events: none`——表现为「模态框没了但整个界面点不动」。
   * 把对话框推迟到菜单卸载后的下一帧即可让两层永不重叠。
   */
  const handleMenuOpenChange = (open: boolean): void => {
    setMenuOpen(open);
    if (open) return;
    const pending = pendingDialogRef.current;
    pendingDialogRef.current = null;
    if (!pending) return;
    window.setTimeout(() => {
      if (pending === 'rename') setRenameOpen(true);
      else setDeleteOpen(true);
    }, 0);
  };

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="ai00-x-task-actions__trigger"
            aria-label={t('nav.workbenchWindow.tasks.actions')}
            title={t('nav.workbenchWindow.tasks.actions')}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} data-no-penetrate>
          <DropdownMenuItem onClick={() => { pendingDialogRef.current = 'rename'; }}>
            <Pencil size={13} />
            <span>{t('nav.workbenchWindow.tasks.rename')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleArchive}>
            {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            <span>
              {t(
                archived
                  ? 'nav.workbenchWindow.tasks.unarchive'
                  : 'nav.workbenchWindow.tasks.archive',
              )}
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            destructive
            onClick={() => {
              pendingDialogRef.current = 'delete';
            }}
          >
            <Trash2 size={13} />
            <span>{t('nav.workbenchWindow.tasks.delete')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <InputDialog
        isOpen={renameOpen}
        onClose={() => setRenameOpen(false)}
        title={t('nav.workbenchWindow.tasks.renameTitle')}
        defaultValue={task.title}
        confirmText={t('nav.workbenchWindow.tasks.renameSave')}
        onConfirm={(value) => {
          const title = value.trim();
          setRenameOpen(false);
          if (!title || title === task.title) return;
          updateTask(task.id, { title });
          // 会话标题跟着改（失败不影响卡片重命名）
          if (task.agentSessionId) {
            void dshSession.rename(task.agentSessionId, title).catch(() => undefined);
          }
        }}
      />

      <ConfirmDialog
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t('nav.workbenchWindow.tasks.deleteTitle')}
        message={t('nav.workbenchWindow.tasks.deleteMessage')}
        confirmDanger
        confirmText={t('nav.workbenchWindow.tasks.delete')}
        onConfirm={() => {
          // 先关对话框、下一帧再删卡：删卡会让本组件（含 Dialog）整棵卸载，
          // 同一帧卸载会跳过 Radix 的 body pointer-events 恢复（整页点不动）。
          setDeleteOpen(false);
          window.setTimeout(() => {
            // 隔离执行的任务：顺手回收 worktree。脏目录会被 Git 拒绝——刻意保留，
            // 交回用户处理，避免删卡时连未提交改动一起抹掉。
            if (task.worktreePath) {
              const project = useTodoStore
                .getState()
                .data.projects.find((p) => p.id === task.projectId);
              if (project) {
                void releaseWorktree(project.dir, task.worktreePath).catch(() => undefined);
              }
            }
            deleteTask(task.id);
            onDeleted?.();
          }, 0);
        }}
      />
    </>
  );
};

export default TaskActionsMenu;
