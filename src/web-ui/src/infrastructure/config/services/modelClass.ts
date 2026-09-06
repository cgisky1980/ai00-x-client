/**
 * modelClass — AI 模型三概念分类（Local / Ai00-API / 自定义远程 API）。
 *
 * - local: 本地推理模型（RWKV 本地 + llama.cpp GGUF 本地）
 * - ai00-api: 官方收费 API 服务（ai00s fake 入口，子模型列表由远程服务器下发）
 * - custom: 用户自填的远程 API 配置
 *
 * 数据层（ai.models）不变，仅 UI 层按此分类呈现。
 */
import type { AIModelConfig } from '../types';

export type ModelClass = 'local' | 'ai00-api' | 'custom';

/** 本地模型：RWKV 本地推理 + llama.cpp GGUF 本地模型 */
export const isLocalModelConfig = (m: AIModelConfig): boolean => {
  const provider = (m.provider || '').trim().toLowerCase();
  const id = (m.id || '').trim().toLowerCase();
  return provider === 'rwkv' || id === 'rwkv-local' || id.startsWith('gguf-local:');
};

/** Ai00-API 入口条目（服务器子模型的统一 fake 载体） */
export const isAi00ApiEntry = (m: AIModelConfig): boolean =>
  (m.provider || '').trim().toLowerCase() === 'ai00s';

export const classifyModel = (m: AIModelConfig): ModelClass =>
  isAi00ApiEntry(m) ? 'ai00-api' : isLocalModelConfig(m) ? 'local' : 'custom';

/** 从 GGUF 本地模型的 model_name（gguf 文件绝对路径）提取干净显示名（文件 stem） */
export const getGgufModelDisplayName = (modelName: string): string => {
  const fileName = modelName.split(/[\\/]/).pop() || modelName;
  return fileName.replace(/\.gguf$/i, '');
};
