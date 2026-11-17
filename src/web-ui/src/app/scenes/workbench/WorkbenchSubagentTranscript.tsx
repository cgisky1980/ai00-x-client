/**
 * WorkbenchSubagentTranscript — 子代理卡内就地展开的「它到底做了什么」。
 *
 * 数据来源就是子会话自己的历史（`session/page`，子代理地址），与主对话
 * 用的是同一套消息折叠（`foldEvents`）与气泡（`MessageBubble`），所以子代理
 * 的推理/工具/结论在主对话里是同一副样子，不需要另学一套阅读方式。
 *
 * 运行中每 2s 拉一次尾部页（`maxMessages` 小值），结束后再拉一次全量收口；
 * 只在卡片展开时挂载，收起即停止，不给后台压轮询。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import {
  dshSession,
  foldEvents,
  type DshMessage,
  type DshToolCallView,
} from '@/infrastructure/api/service-api/DshAPI';
import { MessageBubble } from '../dsh/DshChatPieces';
import { groupMessagesForDisplay } from '../dsh/messageGroups';

/** 运行中轮询间隔（子代理的一步通常远慢于此，再快只是白耗请求）。 */
const POLL_MS = 2_000;
/** 尾部页消息预算：够覆盖一屏上下文，又不至于每次拉全量。 */
const TAIL_MESSAGES = 120;

/**
 * 工具行摘要：只取一个最能说明「做了什么」的短字段。
 * 参数本身是 JSON 串的（有些工具把整包入参塞进 description）一律不展示，
 * 否则一行 200 字符的开发字段会把过程区挤满。
 */
function toolBrief(call: DshToolCallView): string {
  try {
    const args = JSON.parse(call.arguments ?? '{}') as Record<string, unknown>;
    for (const key of ['description', 'command', 'query', 'path', 'file_path', 'label', 'prompt']) {
      const value = args[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      const text = value.trim().replace(/\s+/g, ' ');
      if (text.startsWith('{') || text.startsWith('[')) continue;
      return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
  } catch {
    // 参数不是合法 JSON：不展示摘要
  }
  return '';
}

export interface WorkbenchSubagentTranscriptProps {
  childSessionId: string;
  /** 子会话是否仍在跑：跑着才轮询。 */
  running: boolean;
}

export const WorkbenchSubagentTranscript: React.FC<WorkbenchSubagentTranscriptProps> = ({
  childSessionId,
  running,
}) => {
  const { t } = useTranslation('common');
  const [messages, setMessages] = useState<DshMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 只接受最后一次请求的结果（轮询与收口请求可能交错返回）。 */
  const tokenRef = useRef(0);

  const load = useCallback(
    async (tailOnly: boolean): Promise<void> => {
      const token = ++tokenRef.current;
      try {
        const { events } = await dshSession.history(
          childSessionId,
          tailOnly ? { maxMessages: TAIL_MESSAGES } : undefined,
        );
        if (token !== tokenRef.current) return;
        // 首条 user 消息就是派发时的任务书（卡内「查看任务书」已有），重复一遍
        // 只会把真正的「它做了什么」挤到折叠线以下。续聊消息从第二条起保留。
        // 尾部轮询页可能从会话中间开始，不做这条裁剪，避免两帧之间内容跳动。
        const folded = foldEvents(events.map(entry => entry.event));
        setMessages(!tailOnly && folded[0]?.role === 'user' ? folded.slice(1) : folded);
        setError(null);
      } catch (err) {
        if (token !== tokenRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (token === tokenRef.current) setLoading(false);
      }
    },
    [childSessionId],
  );

  // 切换子会话：清空后拉全量
  useEffect(() => {
    setMessages([]);
    setLoading(true);
    setError(null);
    void load(false);
  }, [load]);

  // 运行中轮询尾部
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => void load(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  // 由跑转停：补一次全量，收口最后一步的落盘内容
  const wasRunningRef = useRef(running);
  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = running;
    if (wasRunning && !running) void load(false);
  }, [running, load]);

  const display = groupMessagesForDisplay(messages);

  /**
   * 卡内工具行压成一行：只留「工具名 + 一句摘要」。
   *
   * 主对话里的工具卡可以展开看完整参数，但子代理卡本身已经是「二级视图」，
   * 再嵌一层可展开的 JSON 参数会把 240px 的过程区塞满开发者字段——恰恰是
   * 用户说的「信息挤在一起、看不出在干什么」。要看原始参数回主对话那条记录。
   */
  const renderToolCall = (call: DshToolCallView): React.ReactNode => (
    <div
      className={`ai00-x-wb-subagent__tool${
        call.isError ? ' is-error' : call.pending ? ' is-pending' : ''
      }`}
      title={call.name}
    >
      {call.pending ? (
        <RefreshCw size={10} className="ai00-x-wb-subagent__spin" aria-hidden="true" />
      ) : call.isError ? (
        <XCircle size={10} aria-hidden="true" />
      ) : (
        <CheckCircle2 size={10} aria-hidden="true" />
      )}
      <span className="ai00-x-wb-subagent__tool-name">{call.name}</span>
      {toolBrief(call) && <span className="ai00-x-wb-subagent__tool-brief">{toolBrief(call)}</span>}
    </div>
  );

  if (loading) {
    return <div className="ai00-x-wb-subagent__hint">{t('nav.workbenchWindow.subagentLoading')}</div>;
  }
  if (error) {
    return (
      <div className="ai00-x-wb-subagent__hint is-error" role="alert">
        {error}
      </div>
    );
  }
  if (display.length === 0) {
    return (
      <div className="ai00-x-wb-subagent__hint">
        {running
          ? t('nav.workbenchWindow.subagentWaiting')
          : t('nav.workbenchWindow.subagentNoOutput')}
      </div>
    );
  }

  return (
    <div className="ai00-x-wb-subagent__transcript">
      {display.map(message => (
        <MessageBubble key={message.id} message={message} renderToolCall={renderToolCall} />
      ))}
    </div>
  );
};
