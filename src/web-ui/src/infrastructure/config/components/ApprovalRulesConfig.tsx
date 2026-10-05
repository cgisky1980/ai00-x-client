/**
 * ApprovalRulesConfig — 工具授权白名单（R2-11b：「总是允许」的持久记录）。
 *
 * 引擎审批词汇只有 allowed-once，应答权在客户端：用户在审批卡点「总是允许」
 * 后，后续同类审批由客户端自动应答（见 shared/agent-approval-rules.ts）。
 * 本页是该持久层的管理入口——查看与移除。
 *
 * 安全红线：只有 read 类工具会被记住，故本页不提供「新增」动作——持久授权
 * 只能由用户在审批卡上的真实点击产生，不能在设置页凭空造出来。
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, IconButton } from '@/component-library';
import { Trash2 } from 'lucide-react';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageSection,
} from './common';
import {
  clearPersistentAllowances,
  forgetPersistentAllow,
  listPersistentAllowances,
  subscribeAllowances,
  type PersistentAllowance,
} from '@/shared/agent-approval-rules';
import './ApprovalRulesConfig.scss';

const ApprovalRulesConfig: React.FC = () => {
  const { t } = useTranslation('settings/approval-rules');
  const [entries, setEntries] = useState<PersistentAllowance[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    const sync = () => setEntries(listPersistentAllowances());
    sync();
    return subscribeAllowances(sync);
  }, []);

  const flash = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2500);
  };

  const handleRemove = (entry: PersistentAllowance) => {
    forgetPersistentAllow(entry.workspace, entry.tool);
    flash(t('messages.removed', { tool: entry.tool }));
  };

  const handleClear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    clearPersistentAllowances();
    setConfirmClear(false);
    flash(t('messages.cleared'));
  };

  return (
    <ConfigPageLayout className="ai00-x-approval-rules-config">
      <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} />

      <ConfigPageContent>
        {message && (
          <div className="ai00-x-approval-rules-config__message">
            <Alert type="success" message={message} />
          </div>
        )}

        <ConfigPageSection
          title={t('section.list.title')}
          description={t('section.list.description')}
          extra={
            entries.length > 0 ? (
              <>
                <Button
                  variant={confirmClear ? 'danger' : 'secondary'}
                  size="small"
                  onClick={handleClear}
                >
                  {confirmClear ? t('actions.clearConfirm') : t('actions.clear')}
                </Button>
                {confirmClear && (
                  <Button variant="ghost" size="small" onClick={() => setConfirmClear(false)}>
                    {t('actions.cancel')}
                  </Button>
                )}
              </>
            ) : null
          }
        >
          {entries.length === 0 ? (
            <div className="ai00-x-approval-rules-config__empty">{t('empty')}</div>
          ) : (
            <div className="ai00-x-approval-rules-config__list">
              {entries.map(entry => (
                <div
                  className="ai00-x-approval-rules-config__row"
                  key={`${entry.workspace}\u0000${entry.tool}`}
                >
                  <div className="ai00-x-approval-rules-config__row-main">
                    <span className="ai00-x-approval-rules-config__tool">{entry.tool}</span>
                    <span
                      className="ai00-x-approval-rules-config__workspace"
                      title={entry.workspace}
                    >
                      {entry.workspace}
                    </span>
                  </div>
                  <IconButton
                    variant="ghost"
                    size="small"
                    onClick={() => handleRemove(entry)}
                    tooltip={t('actions.remove')}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          <p className="ai00-x-approval-rules-config__hint">{t('hint')}</p>
        </ConfigPageSection>
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default ApprovalRulesConfig;
