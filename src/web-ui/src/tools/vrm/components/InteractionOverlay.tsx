import React, { useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { VoiceIndicator } from './VoiceIndicator'
import { ClickEffectRenderer } from './ClickEffectRenderer'
import { SpellEffectRenderer } from './SpellEffectRenderer'
import { GestureTrailRenderer } from './GestureTrailRenderer'
import { PatternGrid } from './PatternGrid'
import { usePatternGrid } from '../hooks/usePatternGrid'
import { useVoiceIndicator } from '../hooks/useVoiceIndicator'
import { useInteractionServices } from '../hooks/useInteractionServices'

export const InteractionOverlay: React.FC = () => {
  useInteractionServices()
  useVoiceIndicator()

  const handleOpenSettings = useCallback(() => {
    invoke('open_task_window', { sessionId: null, sessionTitle: null, openSettings: true }).catch(() => {})
  }, [])

  const handleOpenMain = useCallback(() => {
    invoke('open_task_window', { sessionId: null, sessionTitle: null }).catch(() => {})
  }, [])

  const {
    gridVisible,
    gridCenter,
    gridSize,
    gridSpacing,
    setGridSpacing,
    selectedDots,
    currentPalette,
    matchingActions,
    handleDotSelect,
    handleDotUndo,
    handleConfirm,
    handleQuickAction,
  } = usePatternGrid({
    onOpenSettings: handleOpenSettings,
    onOpenMain: handleOpenMain,
  })

  return (
    <>
      <VoiceIndicator />
      <SpellEffectRenderer />
      <ClickEffectRenderer />
      <GestureTrailRenderer />
      {gridVisible && (
        <PatternGrid
          visible={gridVisible}
          centerX={gridCenter.x}
          centerY={gridCenter.y}
          gridSize={gridSize}
          gridSpacing={gridSpacing}
          onGridSpacingChange={setGridSpacing}
          selectedDots={selectedDots}
          palette={currentPalette}
          matchingActions={matchingActions}
          onDotSelect={handleDotSelect}
          onUndo={handleDotUndo}
          onConfirm={handleConfirm}
          onQuickAction={handleQuickAction}
        />
      )}
    </>
  )
}
