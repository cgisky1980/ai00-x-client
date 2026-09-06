import React, { useCallback } from 'react'
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
    window.dispatchEvent(new CustomEvent('scene:open', { detail: { sceneId: 'settings' } }))
  }, [])

  const handleOpenMain = useCallback(() => {
    window.dispatchEvent(new CustomEvent('scene:open', { detail: { sceneId: 'dsh' } }))
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
