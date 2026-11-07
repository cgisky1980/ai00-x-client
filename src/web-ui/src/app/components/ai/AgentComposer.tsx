/**
 * AgentComposer — 统一内置 AI 对话输入组件（宿主级）。
 *
 * 红线（决策档案 2026-11-07）：所有需要 AI 对话输入的地方一律用本组件，
 * 禁止再拼第四种实现。模型选择等能力全局统一；附加小组件（skill 选择等）
 * 经 footerLeft 选项槽插入，场景侧只传配置不拼 UI。
 *
 * 组成 = design-system PromptInput（输入原语）+ @/shared/components/ModelSelector
 * （生产模型选择器：本地 RWKV 槽位 + Ai00-API 套餐/锁/补贴/积分底栏）。
 * 模型接线（与 ExecChatPanel 同源）：受控值 = 会话当前模型引用
 * （dshSession.models 投影）；切换 = dshSession.selectModel(sessionId,
 * 'ai00-x', ref)——仅同步会话，不写全局配置/卡片字段。
 */
import React, { useEffect, useRef, useState } from 'react';
import { PromptInput, type PromptSubmitIntent } from '@/component-library';
import ModelSelector from '@/shared/components/ModelSelector';
import { dshSession } from '@/infrastructure/api/service-api/DshAPI';

export interface AgentComposerProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * 提交回调。传了 `running` 时会带提交意图：Enter = 'queue'，
   * Ctrl/Cmd+Enter = 'steer'；未传 running 的旧调用方收到无参数调用。
   */
  onSubmit: (intent?: PromptSubmitIntent) => void;
  onStop?: () => void;
  /** 有提交 RPC 未完成（运行中不再阻止继续排队）。 */
  loading?: boolean;
  /** Agent 当前回合运行中：发送与停止并存、运行中可排队/插话。 */
  running?: boolean;
  /** 正在停止当前回合（停止按钮防重入）。 */
  stopping?: boolean;
  /** 是否显示 Enter/插话快捷键提示（默认显示）。 */
  showShortcutHint?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** 输入框最大高度 px（透传 PromptInput，默认 200）。 */
  maxHeight?: number;
  /** 绑定会话：模型目录拉取与切换写回的目标（缺省不显示模型选择器）。 */
  sessionId?: string | null;
  /** 是否显示模型选择器（默认 sessionId 存在即显示）。 */
  showModelSelector?: boolean;
  /** 模型切换失败回调（默认 console.error）。 */
  onError?: (message: string) => void;
  /** 追加左侧选项槽内容（skill 选择等，渲染在模型选择器之后）。 */
  footerLeft?: React.ReactNode;
  /** 右侧辅助信息槽。 */
  footerRight?: React.ReactNode;
}

export const AgentComposer: React.FC<AgentComposerProps> = ({
  value,
  onChange,
  onSubmit,
  onStop,
  loading,
  running,
  stopping,
  showShortcutHint,
  placeholder,
  disabled,
  maxHeight,
  sessionId,
  showModelSelector = true,
  onError,
  footerLeft,
  footerRight,
}) => {
  // 会话当前模型引用（受控值）；切换仅同步会话，不写全局配置
  const [currentRef, setCurrentRef] = useState<string | null>(null);
  /** 引擎目录里的可读名（`ai00-api` → 「AI00-API」等）。 */
  const [currentLabel, setCurrentLabel] = useState<string | null>(null);
  /** 上一次确认的模型引用：切换失败回滚到它，避免 UI 显示与引擎不一致。 */
  const confirmedRef = useRef<string | null>(null);
  const confirmedLabelRef = useRef<string | null>(null);
  /** 引擎目录里可路由的模型引用（选择器的可选范围以此为准）。 */
  const [engineModelRefs, setEngineModelRefs] = useState<string[] | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setCurrentRef(null);
      setCurrentLabel(null);
      setEngineModelRefs(null);
      confirmedRef.current = null;
      confirmedLabelRef.current = null;
      return undefined;
    }
    let alive = true;
    setCurrentRef(null);
    setCurrentLabel(null);
    setEngineModelRefs(null);
    confirmedRef.current = null;
    confirmedLabelRef.current = null;
    dshSession
      .models(sessionId)
      .then(m => {
        if (!alive) return;
        const ref = m.current?.model ?? null;
        setCurrentRef(ref);
        confirmedRef.current = ref;
        const ids = m.groups.flatMap(g => g.models).map(x => x.id);
        setEngineModelRefs(ids);
        // 只解析「展示名」，不新增可选模型：可选模型域仍是生产 ModelSelector
        const label =
          m.groups
            .flatMap(g => g.models)
            .find(x => x.id === ref)?.name ?? null;
        setCurrentLabel(label);
        confirmedLabelRef.current = label;
      })
      .catch(() => undefined); // 目录拉取失败不阻塞输入
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const handleSelectModel = (ref: string): void => {
    if (!sessionId || running) return;
    const previous = confirmedRef.current;
    const previousLabel = confirmedLabelRef.current;
    // 手工切换后由 ModelSelector 自己解析展示名（应用模型域/ai00s 子模型都能解析）
    setCurrentRef(ref);
    setCurrentLabel(null);
    dshSession
      .selectModel(sessionId, 'ai00-x', ref)
      .then(() => {
        confirmedRef.current = ref;
        confirmedLabelRef.current = null;
      })
      .catch(err => {
        // 失败回滚：保持 UI 与实际会话模型一致
        setCurrentRef(previous);
        setCurrentLabel(previousLabel);
        const message = err instanceof Error ? err.message : String(err);
        if (onError) onError(message);
        else console.error('[AgentComposer] selectModel failed:', message);
      });
  };

  return (
    <PromptInput
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      onStop={onStop}
      loading={loading}
      running={running}
      stopping={stopping}
      showShortcutHint={showShortcutHint}
      placeholder={placeholder}
      disabled={disabled}
      maxHeight={maxHeight}
      footerLeft={
        <>
          {showModelSelector && sessionId && (
            <ModelSelector
              currentMode="agent-composer"
              controlledValue={currentRef}
              onControlledSelect={handleSelectModel}
              disabled={Boolean(running || stopping)}
              displayLabel={currentLabel}
              allowedModelRefs={engineModelRefs}
            />
          )}
          {footerLeft}
        </>
      }
      footerRight={footerRight}
    />
  );
};

export default AgentComposer;

