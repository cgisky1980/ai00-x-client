/**
 * AceStep music generation module.
 *
 * Backend bindings + shared UI for the music domain. The creation UI lives
 * in `./create` (quick editor + track editor, AI00-Music agent); playback
 * lives in `playerStore` + `PlayerEngine`. The retired chat-flow creation
 * stack (acestepStore, ChatCreateView, LegoFlowPanel…) was removed —
 * creations are now persisted by `create/createStore.ts` reusing the same
 * `acestep_session_*` commands.
 */

export * from './types';
export { AceStepService, aceStepService } from './services/AceStepService';
export { AudioPlayer } from './components/AudioPlayer';
