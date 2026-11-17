/**
 * ProjectGitBadge — 项目行上的 Git 徽标（当前分支 + 脏标记）。
 *
 * 只读展示 + 切分支（对齐 ZCode 的工作区级分支切换）：脏工作区切分支时先问
 * 「提交并切换 / 直接切换 / 取消」。真正改代码仍由 Agent 在项目目录里做。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, GitBranch, Loader2 } from 'lucide-react';
import {
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/component-library';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import type { GitBranch as GitBranchInfo } from '@/infrastructure/api/service-api/GitAPI';
import {
  EMPTY_GIT_STATE,
  listLocalBranches,
  readProjectGit,
  switchProjectBranch,
  type ProjectGitState,
} from './projectGit';
import './ProjectGitBadge.scss';

export interface ProjectGitBadgeProps {
  /** 项目目录（工作区根）。 */
  dir: string;
  /** 切换失败等错误交给宿主统一展示。 */
  onError?: (message: string) => void;
}

export const ProjectGitBadge: React.FC<ProjectGitBadgeProps> = ({ dir, onError }) => {
  const { t } = useI18n('common');
  const [state, setState] = useState<ProjectGitState>(EMPTY_GIT_STATE);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 菜单里点了脏工作区上的分支：菜单卸载后再开确认框（Radix 双层 pointer-events 陷阱）。 */
  const pendingBranchRef = useRef<string | null>(null);
  const [dirtyTarget, setDirtyTarget] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setState(await readProjectGit(dir));
  }, [dir]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 分支列表只在打开菜单时拉（项目多时避免每个项目都跑一遍 git branch）。 */
  const loadBranches = useCallback(async (): Promise<void> => {
    setBranches(await listLocalBranches(dir));
  }, [dir]);

  const doSwitch = useCallback(
    async (branch: string): Promise<void> => {
      setBusy(true);
      try {
        await switchProjectBranch(dir, branch);
        await reload();
      } catch (e) {
        onError?.(t('nav.workbenchWindow.projects.git.switchFailed', {
          message: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        setBusy(false);
      }
    },
    [dir, onError, reload, t],
  );

  const handleMenuOpenChange = (open: boolean): void => {
    setMenuOpen(open);
    if (open) {
      void loadBranches();
      return;
    }
    if (state.isRepo) void reload();
    const pending = pendingBranchRef.current;
    pendingBranchRef.current = null;
    if (!pending) return;
    window.setTimeout(() => setDirtyTarget(pending), 0);
  };

  const pickBranch = (branch: string): void => {
    if (busy || branch === state.branch) return;
    if (state.dirty) {
      pendingBranchRef.current = branch;
      return;
    }
    void doSwitch(branch);
  };

  if (!state.isRepo) {
    return (
      <span className="ai00-x-project-git is-none" title={t('nav.workbenchWindow.projects.git.notRepo')}>
        {t('nav.workbenchWindow.projects.git.notRepo')}
      </span>
    );
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`ai00-x-project-git${state.dirty ? ' is-dirty' : ''}`}
            title={`${state.branch} · ${
              state.dirty
                ? t('nav.workbenchWindow.projects.git.dirty')
                : t('nav.workbenchWindow.projects.git.clean')
            }`}
            aria-label={`${t('nav.workbenchWindow.projects.git.branch')}: ${state.branch}`}
            onClick={(event) => event.stopPropagation()}
          >
            {busy ? <Loader2 size={11} className="ai00-x-project-git__spin" /> : <GitBranch size={11} />}
            <span className="ai00-x-project-git__name">{state.branch}</span>
            {state.dirty && <span className="ai00-x-project-git__dot" aria-hidden />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} data-no-penetrate>
          <DropdownMenuLabel>
            {state.dirty
              ? t('nav.workbenchWindow.projects.git.dirty')
              : t('nav.workbenchWindow.projects.git.clean')}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {branches.length === 0 ? (
            <DropdownMenuItem disabled>{t('nav.workbenchWindow.projects.git.loading')}</DropdownMenuItem>
          ) : (
            branches.map((item) => (
              <DropdownMenuItem key={item.name} onClick={() => pickBranch(item.name)}>
                {item.name === state.branch ? <Check size={13} /> : <span className="ai00-x-project-git__slot" />}
                <span>{item.name}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        isOpen={dirtyTarget !== null}
        onClose={() => setDirtyTarget(null)}
        type="warning"
        title={t('nav.workbenchWindow.projects.git.dirtyTitle')}
        message={t('nav.workbenchWindow.projects.git.dirtyMessage', {
          branch: dirtyTarget ?? '',
        })}
        confirmText={t('nav.workbenchWindow.projects.git.dirtyConfirm')}
        cancelText={t('nav.workbenchWindow.projects.git.cancel')}
        onConfirm={() => {
          const branch = dirtyTarget;
          setDirtyTarget(null);
          if (branch) void doSwitch(branch);
        }}
        onCancel={() => setDirtyTarget(null)}
      />
    </>
  );
};
