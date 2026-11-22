import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageRow,
  ConfigPageSection,
} from './common';
import { Switch } from '@/component-library';
import { useIslandStore } from '@/tools/island/store/islandStore';
import { ISLAND_ROWS } from '@/tools/island/islandRows';
import './IslandConfig.scss';

/**
 * 灵动岛行配置：模块开关 + 常驻行排序（借鉴岛仔 Daozai）。
 * 所有行 DOM 常驻以保住插件槽 #ai00-island-slot，开关仅隐藏视觉。
 */
const IslandConfig: React.FC = () => {
  const { t } = useTranslation();
  const rowConfig = useIslandStore((s) => s.rowConfig);
  const setRowEnabled = useIslandStore((s) => s.setRowEnabled);
  const setRowOrder = useIslandStore((s) => s.setRowOrder);
  const resetRowConfig = useIslandStore((s) => s.resetRowConfig);

  // 按当前 order 排序，用于上下移动时交换相邻行
  const ordered = [...ISLAND_ROWS].sort(
    (a, b) => rowConfig[a.id].order - rowConfig[b.id].order
  );

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    const a = ordered[index];
    const b = ordered[target];
    const aOrder = rowConfig[a.id].order;
    const bOrder = rowConfig[b.id].order;
    setRowOrder(a.id, bOrder);
    setRowOrder(b.id, aOrder);
  };

  return (
    <ConfigPageLayout className="ai00-x-island-config">
      <ConfigPageHeader
        title={t('islandConfig.title', { defaultValue: '灵动岛' })}
        subtitle={t('islandConfig.subtitle', {
          defaultValue: '配置灵动岛展开面板的行为与显示',
        })}
      />
      <ConfigPageContent>
        <ConfigPageSection
          title={t('islandConfig.rows.title', { defaultValue: '显示行' })}
          description={t('islandConfig.rows.description', {
            defaultValue: '关闭的行不再显示；所有行的插件按钮会保留在 DOM 中。',
          })}
        >
          {ordered.map((row, index) => (
            <ConfigPageRow
              key={row.id}
              label={t(`islandConfig.rows.${row.id}`, { defaultValue: row.label })}
              description={
                row.compactVisible
                  ? t('islandConfig.rows.alwaysOnCompact', {
                      defaultValue: '收起态常驻显示',
                    })
                  : undefined
              }
              align="center"
            >
              <div className="ai00-x-island-config__controls">
                <button
                  className="ai00-x-island-config__move"
                  title={t('islandConfig.rows.moveUp', { defaultValue: '上移' })}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  className="ai00-x-island-config__move"
                  title={t('islandConfig.rows.moveDown', { defaultValue: '下移' })}
                  disabled={index === ordered.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <Switch
                  checked={rowConfig[row.id].enabled}
                  onChange={(e) => setRowEnabled(row.id, e.target.checked)}
                />
              </div>
            </ConfigPageRow>
          ))}
          <ConfigPageRow
            label={t('islandConfig.rows.reset', { defaultValue: '恢复默认' })}
            description={t('islandConfig.rows.resetHint', {
              defaultValue: '恢复所有行的显示与顺序',
            })}
            align="center"
          >
            <button className="ai00-x-island-config__reset" onClick={resetRowConfig}>
              <RotateCcw size={14} />
              {t('islandConfig.rows.reset', { defaultValue: '恢复默认' })}
            </button>
          </ConfigPageRow>
        </ConfigPageSection>
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default IslandConfig;
