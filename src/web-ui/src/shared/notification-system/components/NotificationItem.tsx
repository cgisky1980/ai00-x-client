 

import React from 'react';
import { X, CheckCircle, XCircle, AlertTriangle, Info } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { Notification } from '../types';
import { notificationService } from '../services/NotificationService';
import './NotificationItem.scss';

export interface NotificationItemProps {
  notification: Notification;
}

export const NotificationItem: React.FC<NotificationItemProps> = ({ notification }) => {
  const { id, type, title, message, messageNode, closable, actions } = notification;
  const { t } = useI18n('common');

  
  const getIcon = () => {
    switch (type) {
      case 'success':
        return <CheckCircle size={14} />;
      case 'error':
        return <XCircle size={14} />;
      case 'warning':
        return <AlertTriangle size={14} />;
      case 'info':
      default:
        return <Info size={14} />;
    }
  };

  
  const handleClose = () => {
    notificationService.dismiss(id);
  };

  
  const handleAction = (onClick: () => void) => {
    onClick();
    
    if (closable) {
      notificationService.dismiss(id);
    }
  };

  /**
   * 「去查看 / 去批准 / 去验收」这类主动作：整张卡都可以点。
   * overlay 窗口是有鼠标穿透的，只有带 `data-no-penetrate` 的区域才收得到点击——
   * 不加这个标记，通知看起来正常但按钮点不动（实测用户反馈）。
   *
   * 判定从「只有一个动作」放宽为「恰好一个 primary」：任务出错这类通知要同时给
   * 「去查看」（primary）和一个直接重试的次要按钮，整卡可点不能被次要按钮顶掉。
   */
  const primaryActions = (actions ?? []).filter((a) => (a.variant ?? 'secondary') === 'primary');
  const singleAction = primaryActions.length === 1 ? primaryActions[0] : null;
  const handleCardClick = (): void => {
    if (singleAction) handleAction(singleAction.onClick);
  };

  return (
    <div
      className={`notification-item notification-item--${type}${singleAction ? ' is-clickable' : ''}`}
      data-no-penetrate
      {...(singleAction
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: handleCardClick,
            onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              handleCardClick();
            },
          }
        : {})}
    >
      
      <div className="notification-item__icon">
        {getIcon()}
      </div>

      
      <div className="notification-item__content">
        <div className="notification-item__title">{title}</div>
        <div className="notification-item__message">{messageNode ?? message}</div>

        
        {actions && actions.length > 0 && (
          <div className="notification-item__actions">
            {actions.map((action, index) => (
              <button
                key={index}
                className={`notification-item__action notification-item__action--${action.variant || 'secondary'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleAction(action.onClick);
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>

      
      {closable && (
        <button
          className="notification-item__close"
          onClick={(e) => {
            e.stopPropagation();
            handleClose();
          }}
          aria-label={t('actions.close')}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
};

