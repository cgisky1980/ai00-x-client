/**
 * AceStep music generation module.
 *
 * Provides text-to-music generation via FFI to acestep.cpp (GGML-based).
 * Conversational creation flow: Ai00-X LLM plans → DiT synthesizes (no LM).
 */

export * from './types';
export { AceStepService, aceStepService } from './services/AceStepService';
export { useAceStepStore } from './store/acestepStore';
export type { GenerationState } from './store/acestepStore';
export { useAceStep, useAceStepEvents } from './hooks/useAceStep';
export { ModelLoader } from './components/ModelLoader';
export { AudioPlayer } from './components/AudioPlayer';
