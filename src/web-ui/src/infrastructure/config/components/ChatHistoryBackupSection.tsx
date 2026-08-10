import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { save, open } from '@tauri-apps/plugin-dialog';
import { Download, Upload, Loader2, FileArchive, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  Button,
  Modal,
} from '@/component-library';
import {
  ConfigPageRow,
} from './common';

interface BackupResult {
  files: number;
  bytes: number;
  path: string;
}

type DialogMode = 'export' | 'import' | null;

/** Format bytes as human-readable size (e.g. "12.4 MB"). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const ChatHistoryBackupSection: React.FC = () => {
  const { t } = useTranslation('settings/account');
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const openExportDialog = () => {
    setPassword('');
    setPasswordConfirm('');
    setError('');
    setSuccess('');
    setDialogMode('export');
  };

  const openImportDialog = () => {
    setPassword('');
    setSelectedFile(null);
    setError('');
    setSuccess('');
    setDialogMode('import');
  };

  // Listen for "open-chat-history-export" event (e.g. from device-unbind modal)
  useEffect(() => {
    const handler = () => openExportDialog();
    window.addEventListener('open-chat-history-export', handler);
    return () => window.removeEventListener('open-chat-history-export', handler);
  }, []);

  const closeDialog = () => {
    if (processing) return;
    setDialogMode(null);
    setPassword('');
    setPasswordConfirm('');
    setSelectedFile(null);
    setError('');
    setSuccess('');
  };

  const handleSelectBackupFile = async () => {
    setError('');
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: t('chatHistory.backupFileExt', { defaultValue: 'Ai00-X Backup File' }), extensions: ['ai00x-backup'] },
        ],
      });
      if (typeof selected === 'string') {
        setSelectedFile(selected);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleExport = async () => {
    setError('');
    if (password.length < 6) {
      setError(t('chatHistory.passwordTooShort', { defaultValue: 'Password must be at least 6 characters' }));
      return;
    }
    if (password !== passwordConfirm) {
      setError(t('chatHistory.passwordMismatch', { defaultValue: 'Passwords do not match' }));
      return;
    }

    // Trigger save dialog to choose output path
    let outputPath: string | null = null;
    try {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const defaultName = `ai00x-chat-backup-${stamp}.ai00x-backup`;
      outputPath = await save({
        title: t('chatHistory.exportDialogTitle', { defaultValue: 'Export Chat History' }),
        defaultPath: defaultName,
        filters: [
          { name: t('chatHistory.backupFileExt', { defaultValue: 'Ai00-X Backup File' }), extensions: ['ai00x-backup'] },
        ],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (outputPath === null) {
      // User cancelled the save dialog
      return;
    }

    setProcessing(true);
    try {
      const result = await invoke<BackupResult>('chat_history_export', {
        password,
        outputPath,
      });
      setSuccess(
        t('chatHistory.exportSuccess', {
          defaultValue: 'Export succeeded: backed up {{files}} files ({{size}})',
          files: result.files,
          size: formatSize(result.bytes),
        })
      );
      // Close dialog after short delay so user can see the success message
      setTimeout(() => {
        setDialogMode(null);
        setPassword('');
        setPasswordConfirm('');
        setSuccess('');
      }, 2000);
    } catch (e) {
      setError(`${t('chatHistory.exportFailed', { defaultValue: 'Export failed' })}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProcessing(false);
    }
  };

  const handleImport = async () => {
    setError('');
    if (!selectedFile) {
      setError(t('chatHistory.noFileSelected', { defaultValue: 'No file selected' }));
      return;
    }
    if (password.length < 6) {
      setError(t('chatHistory.passwordTooShort', { defaultValue: 'Password must be at least 6 characters' }));
      return;
    }

    setProcessing(true);
    try {
      const result = await invoke<BackupResult>('chat_history_import', {
        password,
        inputPath: selectedFile,
      });
      setSuccess(
        t('chatHistory.importSuccess', {
          defaultValue: 'Import succeeded: restored {{files}} files ({{size}})',
          files: result.files,
          size: formatSize(result.bytes),
        })
      );
      setTimeout(() => {
        setDialogMode(null);
        setPassword('');
        setSelectedFile(null);
        setSuccess('');
      }, 2000);
    } catch (e) {
      setError(`${t('chatHistory.importFailed', { defaultValue: 'Import failed' })}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProcessing(false);
    }
  };

  const getFilename = (path: string): string => {
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
  };

  return (
    <>
      <ConfigPageRow
        label={t('chatHistory.title', { defaultValue: 'Chat History' })}
        description={t('chatHistory.sectionDesc', { defaultValue: 'Export all chat history as an encrypted archive.' })}
        align="center"
      >
        <div className="ai00-x-account-config__chat-history-actions">
          <Button
            variant="secondary"
            size="small"
            onClick={openExportDialog}
            disabled={processing}
          >
            <Download size={14} />
            <span>{t('chatHistory.exportBtn', { defaultValue: 'Export Chat History' })}</span>
          </Button>
          <Button
            variant="secondary"
            size="small"
            onClick={openImportDialog}
            disabled={processing}
          >
            <Upload size={14} />
            <span>{t('chatHistory.importBtn', { defaultValue: 'Import Chat History' })}</span>
          </Button>
        </div>
      </ConfigPageRow>

      <Modal
        isOpen={dialogMode !== null}
        onClose={closeDialog}
        title={
          dialogMode === 'export'
            ? t('chatHistory.exportDialogTitle', { defaultValue: 'Export Chat History' })
            : t('chatHistory.importDialogTitle', { defaultValue: 'Import Chat History' })
        }
        size="small"
        closeOnOverlayClick={!processing}
        showCloseButton={!processing}
      >
        <div className="ai00-x-account-config__backup-modal">
          {/* Description */}
          <p className="ai00-x-account-config__backup-modal-desc">
            {dialogMode === 'export'
              ? t('chatHistory.exportConfirmDesc', {
                  defaultValue:
                    'This will package all chat history and encrypt it with your password. Keep the password safe — it cannot be recovered if lost.',
                })
              : t('chatHistory.importConfirmDesc', {
                  defaultValue:
                    'Select a previously exported .ai00x-backup file, enter the password, and restore. Importing overwrites files with the same name.',
                })}
          </p>

          {/* Import: file selector */}
          {dialogMode === 'import' && (
            <div className="ai00-x-account-config__backup-modal-step">
              <label className="ai00-x-account-config__backup-modal-label">
                {t('chatHistory.selectFileBtn', { defaultValue: 'Select Backup File' })}
              </label>
              <div className="ai00-x-account-config__backup-file-row">
                <Button
                  variant="secondary"
                  size="small"
                  onClick={handleSelectBackupFile}
                  disabled={processing}
                >
                  <FileArchive size={14} />
                  <span>{t('chatHistory.selectFileBtn', { defaultValue: 'Select Backup File' })}</span>
                </Button>
                <span className="ai00-x-account-config__backup-file-name">
                  {selectedFile
                    ? t('chatHistory.selectedFile', {
                        defaultValue: 'Selected: {{filename}}',
                        filename: getFilename(selectedFile),
                      })
                    : t('chatHistory.noFileSelected', { defaultValue: 'No file selected' })}
                </span>
              </div>
            </div>
          )}

          {/* Password input */}
          <div className="ai00-x-account-config__backup-modal-step">
            <label className="ai00-x-account-config__backup-modal-label">
              {t('chatHistory.passwordLabel', { defaultValue: 'Encryption Password' })}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('chatHistory.passwordPlaceholder', { defaultValue: 'Enter encryption password (min 6 chars)' })}
              className="ai00-x-account-config__code-input"
              disabled={processing}
              autoFocus
            />
          </div>

          {/* Confirm password (export only) */}
          {dialogMode === 'export' && (
            <div className="ai00-x-account-config__backup-modal-step">
              <label className="ai00-x-account-config__backup-modal-label">
                {t('chatHistory.passwordConfirmLabel', { defaultValue: 'Confirm Password' })}
              </label>
              <input
                type="password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                placeholder={t('chatHistory.passwordConfirmPlaceholder', { defaultValue: 'Re-enter password' })}
                className="ai00-x-account-config__code-input"
                disabled={processing}
              />
            </div>
          )}

          {/* Error / success messages */}
          {error && (
            <div className="ai00-x-account-config__backup-modal-message ai00-x-account-config__backup-modal-message--error">
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          )}
          {success && !error && (
            <div className="ai00-x-account-config__backup-modal-message ai00-x-account-config__backup-modal-message--success">
              <CheckCircle2 size={14} />
              <span>{success}</span>
            </div>
          )}

          {/* Actions */}
          <div className="ai00-x-account-config__backup-modal-actions">
            <Button
              variant="ghost"
              size="small"
              onClick={closeDialog}
              disabled={processing}
            >
              {t('cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button
              variant="primary"
              size="small"
              onClick={dialogMode === 'export' ? handleExport : handleImport}
              disabled={
                processing ||
                password.length < 6 ||
                (dialogMode === 'export' && password !== passwordConfirm) ||
                (dialogMode === 'import' && !selectedFile)
              }
            >
              {processing ? (
                <>
                  <Loader2 size={14} className="ai00-x-account-config__spin" />
                  <span>{t('chatHistory.processing', { defaultValue: 'Processing...' })}</span>
                </>
              ) : (
                <span>{t('chatHistory.confirm', { defaultValue: 'Confirm' })}</span>
              )}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default ChatHistoryBackupSection;
