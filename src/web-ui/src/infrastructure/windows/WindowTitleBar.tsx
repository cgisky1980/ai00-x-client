/**
 * WindowTitleBar — 标准应用窗口的统一自绘标题栏。
 *
 * 配合 window_registry 的无边框窗口（decorations:false）：
 *
 *   ┌─ 窗口（直角矩形，DWM 系统阴影由 builder 默认 shadow(true) 提供）
 *   │ [灵印(动态)][标题][spacer 拖拽区，双击最大化][actions 插槽][钉住][风格][明暗][三键]
 *   │ [内容区：children]
 *
 * 拖拽用 data-tauri-drag-region；置顶走 setAlwaysOnTop（capabilities 已含
 * allow-set-always-on-top）；明暗切换复用 useThemeToggle、风格切换复用 useTheme
 * （与设置页同一持久化链路）。
 */
import { useState, type ReactNode } from 'react';
import { Moon, Palette, Pin, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  IconButton,
  WindowControls,
} from '@/component-library';
import { BrandMark } from '@ai00-x/design-system/react';
import { useWindowControls } from '@/app/hooks/useWindowControls';
import { useTheme, useThemeToggle } from '@/infrastructure/theme/hooks/useTheme';
import type { StylePackId } from '@/infrastructure/theme';
import './WindowTitleBar.scss';

export interface WindowTitleBarProps {
  /** 窗口标题（与 app-windows.json 的 title 一致） */
  title: string;
  /** 标题后跟随的左侧元信息插槽（如 Lv/积分徽标） */
  leading?: ReactNode;
  /** 标题栏右侧自定义按钮插槽（工具按钮与三键之前） */
  actions?: ReactNode;
  /** 窗口内容（渲染在标题栏下方的内容区） */
  children: ReactNode;
}

export function WindowTitleBar({ title, leading, actions, children }: WindowTitleBarProps) {
  const { handleMinimize, handleMaximize, handleClose, isMaximized } = useWindowControls();
  const { toggleTheme, isDark } = useThemeToggle();
  const { t } = useTranslation('common');
  /** 风格包（规范第九节，第二正交轴）：与设置页同一持久化链路 */
  const { stylePackId, stylePacks, setStylePack } = useTheme();
  /** 窗口置顶（钉住）状态 */
  const [pinned, setPinned] = useState(false);

  const handleTogglePin = async () => {
    const next = !pinned;
    await getCurrentWindow().setAlwaysOnTop(next);
    setPinned(next);
  };

  return (
    <div className="app-window-shell">
      <div className="app-window-titlebar">
        <BrandMark variant="seal" size={24} animated className="app-window-titlebar__brand" />
        <span className="app-window-titlebar__title">{title}</span>
        {leading ? <div className="app-window-titlebar__leading">{leading}</div> : null}
        <div className="app-window-titlebar__spacer" data-tauri-drag-region onDoubleClick={handleMaximize} />
        {actions ? <div className="app-window-titlebar__actions">{actions}</div> : null}
        <div className="app-window-titlebar__tools">
          <IconButton
            variant="ghost"
            size="small"
            className={`app-window-titlebar__tool-btn${pinned ? ' is-active' : ''}`}
            tooltip={pinned ? '取消置顶' : '窗口置顶'}
            aria-pressed={pinned}
            onClick={handleTogglePin}
          >
            <Pin size={16} />
          </IconButton>
          <IconButton
            variant="ghost"
            size="small"
            className="app-window-titlebar__tool-btn"
            tooltip={isDark ? '切换亮色（宣纸）' : '切换暗色（墨）'}
            onClick={() => toggleTheme()}
          >
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
          </IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                variant="ghost"
                size="small"
                className="app-window-titlebar__tool-btn"
                tooltip={t('theme.styleTooltip', { defaultValue: '视觉风格' })}
                aria-label={t('theme.styleTooltip', { defaultValue: '视觉风格' })}
              >
                <Palette size={16} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('theme.style', { defaultValue: '视觉风格' })}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={stylePackId}
                onValueChange={(value) => void setStylePack(value as StylePackId)}
              >
                {stylePacks.map((pack) => (
                  <DropdownMenuRadioItem key={pack.id} value={pack.id}>
                    {t(`theme.stylePacks.${pack.id}`, { defaultValue: pack.name })}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="app-window-titlebar__window-controls">
          <WindowControls
            onMinimize={handleMinimize}
            onMaximize={handleMaximize}
            onClose={handleClose}
            isMaximized={isMaximized}
          />
        </div>
      </div>
      <div className="app-window-shell__content">{children}</div>
    </div>
  );
}
