/**
 * ComposeSection — 「乐」窗创作分区。
 *
 * 2026-09 重做：挂载全新创作分区（创作列表 + 按项目类型的快捷/分轨编辑器，
 * AI00-Music 音乐 Agent 接入 AI 网关），替代旧 AceStepWorkspace 聊天式工作台。
 * 播放本体（PlayerEngine + PlayerBridge）在 MusicWindowApp，
 * 创作产出的样例可直接存入曲库进入播放链路。
 */
import React from 'react'
import CreateSection from '../acestep/create/CreateSection'
import './ComposeSection.scss'

export const ComposeSection: React.FC = () => {
  return (
    <div className="compose-section">
      <CreateSection />
    </div>
  )
}
