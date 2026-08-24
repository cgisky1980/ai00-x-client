/** Push button with optional force-push dropdown (DS DropdownMenu). */

import React from 'react';
import { ChevronDown, ArrowUp, AlertTriangle } from 'lucide-react';
import {
  Button,
  IconButton,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/component-library';
import { useI18n } from '@/infrastructure/i18n';
import './PushButton.scss';

export interface PushButtonProps {
  /** Push callback (force = true for force-push) */
  onPush: (force: boolean) => void | Promise<void>;
  /** Disabled state */
  disabled?: boolean;
  /** Loading state */
  loading?: boolean;
  /** Button size */
  size?: 'small' | 'medium' | 'large';
  /** Button variant */
  variant?: 'primary' | 'accent' | 'secondary' | 'ghost';
  /** Custom class name */
  className?: string;
  /** Render as icon-only buttons */
  iconOnly?: boolean;
}

export const PushButton: React.FC<PushButtonProps> = ({
  onPush,
  disabled = false,
  loading = false,
  size = 'small',
  variant = 'accent',
  className = '',
  iconOnly = false
}) => {
  const { t } = useI18n('panels/git');

  const handlePush = async (force: boolean = false) => {
    await onPush(force);
  };

  return (
    <div className={`ai00-x-push-button ${className}`}>
      <DropdownMenu>
        <div className="ai00-x-push-button__wrapper">
          {iconOnly ? (
            <IconButton
              size={size}
              onClick={() => handlePush(false)}
              disabled={disabled || loading}
              className="ai00-x-push-button__main"
            >
              <ArrowUp size={14} />
            </IconButton>
          ) : (
            <Button
              variant={variant}
              size={size}
              onClick={() => handlePush(false)}
              disabled={disabled || loading}
              className="ai00-x-push-button__main"
            >
              <ArrowUp size={14} />
              <span>{t('actions.push')}</span>
            </Button>
          )}

          <DropdownMenuTrigger asChild disabled={disabled || loading}>
            {iconOnly ? (
              <IconButton
                size={size}
                disabled={disabled || loading}
                className="ai00-x-push-button__dropdown-trigger"
              >
                <ChevronDown size={14} className="ai00-x-push-button__arrow" />
              </IconButton>
            ) : (
              <Button
                variant={variant}
                size={size}
                disabled={disabled || loading}
                className="ai00-x-push-button__dropdown-trigger"
              >
                <ChevronDown size={14} className="ai00-x-push-button__arrow" />
              </Button>
            )}
          </DropdownMenuTrigger>
        </div>

        <DropdownMenuContent align="start" sideOffset={4}>
          <DropdownMenuItem onClick={() => handlePush(false)}>
            <ArrowUp size={14} />
            <span>{t('actions.push')}</span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem destructive onClick={() => handlePush(true)}>
            <AlertTriangle size={14} />
            <span>{t('actions.forcePush')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
