import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Music } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { createLogger } from '@/shared/utils/logger';
import './AceStepIslandButton.scss';

const log = createLogger('AceStepIslandButton');

/**
 * Standalone icon button floating next to the Dynamic Island.
 *
 * Opens the ACE-Step music generation scene in the main task window
 * (merged from the former standalone acestep window).
 *
 * Rendered via portal to document.body so it stacks correctly with the
 * Dynamic Island (which is also portaled to body at z-index 50010).
 * Positioned to the right of the island's expanded width (380px → 190px
 * half-width) to avoid overlap in any morph state.
 */
const AceStepIslandButton: React.FC = () => {
  const [opening, setOpening] = useState(false);

  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

  const handleClick = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    try {
      await invoke('open_task_window');
      await emit('open-acestep-scene');
    } catch (e) {
      log.error('Failed to open ACE-Step scene', e);
    } finally {
      setOpening(false);
    }
  }, [opening]);

  if (!isTauri) return null;

  return createPortal(
    <button
      type="button"
      className={`ai00-x-acestep-island-btn no-penetrate${opening ? ' is-busy' : ''}`}
      aria-label="Open AI00-Music"
      title="AI00-Music"
      onClick={handleClick}
      disabled={opening}
    >
      <Music size={15} />
    </button>,
    document.body,
  );
};

export default AceStepIslandButton;
