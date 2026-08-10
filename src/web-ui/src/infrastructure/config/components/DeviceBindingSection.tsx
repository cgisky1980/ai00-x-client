import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Smartphone, Send, Loader2, ShieldAlert, CheckCircle2, AlertTriangle } from 'lucide-react';
import {
  ConfigPageRow,
} from './common';
import { fetchWithAuth } from '@/infrastructure/auth/fetchWithAuth';

interface DeviceStatus {
  bound: boolean;
  machine_code: string | null;
  device_name: string | null;
  bound_at: string | null;
  last_seen_at: string | null;
}

interface DeviceSendCodeResponse {
  sent: boolean;
  email_masked: string;
}

interface SyncResult {
  uploaded: number;
  downloaded: number;
  errors: string[];
}

const DeviceBindingSection: React.FC = () => {
  const { t } = useTranslation('settings/account');
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showUnbindModal, setShowUnbindModal] = useState(false);
  const [emailMasked, setEmailMasked] = useState('');
  const [code, setCode] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadStatus = async () => {
    setLoading(true);
    try {
      const json = await fetchWithAuth<{ code: number; data?: DeviceStatus }>('/ai00-s/api/auth/device_status', {
        method: 'GET',
      });
      if (json?.code === 0 && json.data) {
        setStatus(json.data);
      }
    } catch (e) {
      console.warn('[DeviceBindingSection] load status failed:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  // 验证码冷却倒计时
  useEffect(() => {
    if (codeCooldown <= 0) return;
    const timer = setInterval(() => {
      setCodeCooldown((prev) => Math.max(prev - 1, 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [codeCooldown]);

  const handleSendCode = async () => {
    setError('');
    setSuccess('');
    setSendingCode(true);
    try {
      const json = await fetchWithAuth<{ code: number; message?: string; data?: DeviceSendCodeResponse }>('/ai00-s/api/auth/device_send_code', {
        method: 'POST',
      });
      if (json?.code !== 0) {
        throw new Error(json?.message || 'Failed to send code');
      }
      const data = json.data as DeviceSendCodeResponse;
      setEmailMasked(data.email_masked);
      setCodeCooldown(60);
      setSuccess(t('device.unbindCodeSent', { defaultValue: 'Code sent to your email' }) + ` (${data.email_masked})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send code failed');
    } finally {
      setSendingCode(false);
    }
  };

  const handleUnbind = async () => {
    if (!code.trim()) {
      setError(t('device.unbindCodePlaceholder', { defaultValue: 'Enter email verification code' }));
      return;
    }
    setError('');
    setSuccess('');
    setSubmitting(true);

    // Step 1: 同步本地 profile 到服务端（解绑前备份）
    setSyncing(true);
    try {
      const syncResult = await invoke<SyncResult>('sync_profile_upload');
      if (syncResult.uploaded > 0) {
        console.log(`[DeviceBindingSection] uploaded ${syncResult.uploaded} profile items before unbind`);
      }
      if (syncResult.errors.length > 0) {
        console.warn('[DeviceBindingSection] sync errors (non-fatal):', syncResult.errors);
      }
    } catch (e) {
      // 同步失败不阻断解绑流程，但提示用户
      console.warn('[DeviceBindingSection] profile sync before unbind failed (non-fatal):', e);
    }
    setSyncing(false);

    // Step 2: 调用解绑 API
    try {
      const json = await fetchWithAuth<{
        code: number;
        message?: string;
        data?: { used?: number; limit?: number; month_used?: number; month_limit?: number };
      }>('/ai00-s/api/auth/device_unbind', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      if (json?.code !== 0) {
        // 4023: 月度解绑次数超限，显示更友好的提示
        if (json?.code === 4023) {
          const used = json?.data?.used ?? 0;
          const limit = json?.data?.limit ?? 0;
          throw new Error(
            t('device.monthlyUnbindLimitExceeded', {
              defaultValue: 'Monthly unbind limit reached ({{used}}/{{limit}}). Please contact admin.',
              used,
              limit,
            })
          );
        }
        throw new Error(json?.message || 'Unbind failed');
      }

      // Step 3: 清理本地 profile 数据（解绑后清除设备上的用户资料）
      try {
        await invoke('sync_profile_clear_local');
      } catch (e) {
        console.warn('[DeviceBindingSection] clear local profile failed (non-fatal):', e);
      }

      // 解绑成功提示（含本月已用次数）
      const monthUsed = json?.data?.month_used;
      const monthLimit = json?.data?.month_limit;
      const successMsg = monthUsed != null && monthLimit != null
        ? `${t('device.unbindSuccess', { defaultValue: 'Device unbound successfully.' })} (${monthUsed}/${monthLimit} ${t('device.syncing', { defaultValue: 'this month' })})`
        : t('device.unbindSuccess', { defaultValue: 'Device unbound successfully. Your profile has been synced to the server and will be restored on your next login.' });
      setSuccess(successMsg);
      setShowUnbindModal(false);
      setCode('');
      setEmailMasked('');
      await loadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbind failed');
    } finally {
      setSubmitting(false);
    }
  };

  const formatDate = (iso: string | null): string => {
    if (!iso) return '-';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  if (loading) {
    return (
      <ConfigPageRow
        label={t('device.deviceManage', { defaultValue: 'Device Management' })}
        align="center"
      >
        <Loader2 size={14} className="ai00-x-account-config__spin" />
      </ConfigPageRow>
    );
  }

  if (!status) {
    return null;
  }

  return (
    <>
      <ConfigPageRow
        label={t('device.deviceBound', { defaultValue: 'Device bound' })}
        description={status.bound ? undefined : t('device.deviceNotBound', { defaultValue: 'No device bound' })}
        align="center"
      >
        {status.bound ? (
          <div className="ai00-x-account-config__device-info">
            <Smartphone size={14} />
            <span>{status.device_name || status.machine_code?.slice(0, 8) || 'Unknown'}</span>
            <button
              type="button"
              className="ai00-x-account-config__unbind-btn"
              onClick={() => {
                setShowUnbindModal(true);
                setError('');
                setSuccess('');
              }}
            >
              {t('device.unbindDevice', { defaultValue: 'Unbind Device' })}
            </button>
          </div>
        ) : (
          <span className="ai00-x-account-config__device-not-bound">-</span>
        )}
      </ConfigPageRow>

      {status.bound && (
        <>
          <ConfigPageRow
            label={t('device.boundAt', { defaultValue: 'Bound At' })}
            align="center"
          >
            <span className="ai00-x-account-config__value">{formatDate(status.bound_at)}</span>
          </ConfigPageRow>
          {status.last_seen_at && (
            <ConfigPageRow
              label={t('device.lastSeenAt', { defaultValue: 'Last Active' })}
              align="center"
            >
              <span className="ai00-x-account-config__value">{formatDate(status.last_seen_at)}</span>
            </ConfigPageRow>
          )}
        </>
      )}

      {/* 解绑模态对话框 */}
      {showUnbindModal && (
        <div className="ai00-x-account-config__modal-overlay">
          <div className="ai00-x-account-config__modal">
            <div className="ai00-x-account-config__modal-header">
              <ShieldAlert size={18} />
              <h3>{t('device.unbindDevice', { defaultValue: 'Unbind Device' })}</h3>
            </div>

            <p className="ai00-x-account-config__modal-warning">
              {t('device.unbindDeviceConfirm', {
                defaultValue: 'After unbinding, this device cannot log in to this account. Confirm unbind?',
              })}
            </p>

            {/* 数据迁移说明 */}
            <div className="ai00-x-account-config__migration-info">
              <div className="ai00-x-account-config__migration-section">
                <CheckCircle2 size={14} className="ai00-x-account-config__migration-icon--ok" />
                <span>{t('device.migrationSynced', { defaultValue: 'UI preferences, SSH connections, AI rules — auto-synced to server' })}</span>
              </div>
              <div className="ai00-x-account-config__migration-section ai00-x-account-config__migration-section--column">
                <div className="ai00-x-account-config__migration-row">
                  <AlertTriangle size={14} className="ai00-x-account-config__migration-icon--warn" />
                  <span>{t('device.migrationNotSynced', { defaultValue: 'API Key, SSH passwords, chat history — not migrated, reconfigure on new device' })}</span>
                </div>
                <button
                  type="button"
                  className="ai00-x-account-config__export-now-btn"
                  onClick={() => {
                    // Close unbind modal first, then trigger export dialog
                    setShowUnbindModal(false);
                    setCode('');
                    setError('');
                    setSuccess('');
                    setEmailMasked('');
                    window.dispatchEvent(new CustomEvent('open-chat-history-export'));
                  }}
                  disabled={submitting || syncing}
                >
                  {t('device.exportChatNow', { defaultValue: 'Export chat history now →' })}
                </button>
              </div>
            </div>

            {/* 同步状态指示 */}
            {syncing && (
              <div className="ai00-x-account-config__syncing-status">
                <Loader2 size={14} className="ai00-x-account-config__spin" />
                <span>{t('device.syncingProfile', { defaultValue: 'Syncing your profile to server...' })}</span>
              </div>
            )}

            <div className="ai00-x-account-config__modal-step">
              <label className="ai00-x-account-config__modal-label">
                {t('device.unbindSendCode', { defaultValue: 'Send Unbind Code' })}
                {emailMasked && <span className="ai00-x-account-config__email-hint"> → {emailMasked}</span>}
              </label>
              <button
                type="button"
                className="ai00-x-account-config__send-code-btn"
                onClick={handleSendCode}
                disabled={sendingCode || codeCooldown > 0 || submitting || syncing}
              >
                {sendingCode ? (
                  <Loader2 size={14} className="ai00-x-account-config__spin" />
                ) : codeCooldown > 0 ? (
                  `${codeCooldown}s`
                ) : (
                  <>
                    <Send size={14} />
                    {t('device.unbindSendCode', { defaultValue: 'Send Unbind Code' })}
                  </>
                )}
              </button>
            </div>

            <div className="ai00-x-account-config__modal-step">
              <label className="ai00-x-account-config__modal-label">
                {t('device.unbindCodePlaceholder', { defaultValue: 'Enter email verification code' })}
              </label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t('device.unbindCodePlaceholder', { defaultValue: 'Enter email verification code' })}
                className="ai00-x-account-config__code-input"
                maxLength={10}
                disabled={submitting || syncing}
              />
            </div>

            {error && <p className="ai00-x-account-config__modal-error">{error}</p>}
            {success && !error && (
              <p className="ai00-x-account-config__modal-success">{success}</p>
            )}

            <div className="ai00-x-account-config__modal-actions">
              <button
                type="button"
                className="ai00-x-account-config__cancel-btn"
                onClick={() => {
                  setShowUnbindModal(false);
                  setCode('');
                  setError('');
                  setSuccess('');
                  setEmailMasked('');
                }}
                disabled={submitting || syncing}
              >
                {t('cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                type="button"
                className="ai00-x-account-config__confirm-unbind-btn"
                onClick={handleUnbind}
                disabled={submitting || !code.trim() || syncing}
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="ai00-x-account-config__spin" />
                    {syncing
                      ? t('device.syncing', { defaultValue: 'Syncing...' })
                      : t('device.unbindSubmit', { defaultValue: 'Confirm Unbind' })}
                  </>
                ) : (
                  t('device.unbindSubmit', { defaultValue: 'Confirm Unbind' })
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default DeviceBindingSection;
