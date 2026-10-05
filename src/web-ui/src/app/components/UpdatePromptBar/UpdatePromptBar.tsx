/**
 * 更新提示条（P0-4.2）：overlay 右下角非阻断条。
 * 发现新版 → [立即更新]（passive 安装+自动重启）/ [忽略]（同版本本会话不再打扰）。
 * 根容器 pointer-events:none，条体必须带 .no-penetrate 才能接收鼠标。
 */
import { useI18n } from '@/infrastructure/i18n';
import { useSilentUpdate } from '@/infrastructure/update/silent-update';
import styles from './UpdatePromptBar.module.scss';

export function UpdatePromptBar() {
  const { state, install, dismiss } = useSilentUpdate();
  const { t } = useI18n('common');
  if (!state) return null;

  return (
    <div className={`${styles.bar} no-penetrate`} role="status">
      {state.installing ? (
        <>
          <span className={styles.text}>{t('update.installing')}</span>
          <span className={styles.hint}>{t('update.autoRestart')}</span>
        </>
      ) : (
        <>
          <span className={styles.text}>
            {t('update.available', { version: state.version })}
          </span>
          <span className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void install()}
            >
              {t('update.installNow')}
            </button>
            <button type="button" className={styles.ghost} onClick={dismiss}>
              {t('update.later')}
            </button>
          </span>
        </>
      )}
    </div>
  );
}
