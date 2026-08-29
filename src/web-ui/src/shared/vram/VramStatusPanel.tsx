import React from 'react';
import { useVramStatus } from './useVramStatus';
import './VramStatusPanel.scss';

/**
 * VramStatusPanel — compact VRAM usage + engine residency display with
 * per-engine manual release. Engine rows are rendered dynamically from the
 * registry (plugin-registered engines appear automatically).
 *
 * Visual spec: mono + tabular-nums for numeric output; token-based colors.
 */
export const VramStatusPanel: React.FC = () => {
  const { gpuMemUsage, gpuMemTotal, gpuUsage, engines, releaseEngine } = useVramStatus();

  const usedMb = gpuMemUsage != null ? Math.round(gpuMemUsage / (1024 * 1024)) : null;
  const totalMb = gpuMemTotal != null ? Math.round(gpuMemTotal / (1024 * 1024)) : null;
  const pct =
    usedMb != null && totalMb != null && totalMb > 0
      ? Math.min(100, Math.round((usedMb / totalMb) * 100))
      : null;
  const tier = pct == null ? 'unknown' : pct >= 85 ? 'high' : pct >= 60 ? 'normal' : 'low';

  return (
    <div className="vram-panel">
      <div className="vram-panel__header">
        <span className="vram-panel__title">显存占用</span>
        <span className="vram-panel__value">
          {usedMb != null && totalMb != null
            ? `${usedMb.toLocaleString()} / ${totalMb.toLocaleString()} MB`
            : '不可用'}
        </span>
        {gpuUsage != null && (
          <span className="vram-panel__util">{Math.round(gpuUsage)}%</span>
        )}
      </div>

      <div
        className={`vram-panel__bar vram-panel__bar--${tier}`}
        role="progressbar"
        aria-valuenow={pct ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="VRAM usage"
      >
        <div className="vram-panel__bar-fill" style={{ width: `${pct ?? 0}%` }} />
      </div>

      <div className="vram-panel__engines">
        {engines.map((engine) => (
          <div key={engine.engineId} className="vram-panel__engine">
            <span
              className={`vram-panel__dot ${engine.resident ? 'is-resident' : ''} ${
                engine.busy ? 'is-busy' : ''
              }`}
              title={engine.busy ? '推理中' : engine.resident ? '驻留中' : '未加载'}
            />
            <span className="vram-panel__engine-name">{engine.displayName}</span>
            {engine.resident ? (
              <button
                type="button"
                className="vram-panel__release"
                disabled={engine.busy}
                onClick={() => {
                  void releaseEngine(engine.engineId);
                }}
              >
                {engine.busy ? '推理中' : '释放'}
              </button>
            ) : (
              <span className="vram-panel__idle">未加载</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default VramStatusPanel;
