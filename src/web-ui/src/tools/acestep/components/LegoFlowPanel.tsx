/**
 * LegoFlowPanel — multi-step layered creation UI for lego-mode sessions.
 *
 * Replaces the right sidebar (SessionParamsPanel + SessionAudioList) when the
 * active session is in lego mode. Drives the multi-step flow:
 *   1. LLM plans N steps (visible in chat)
 *   2. Each step generates 2 candidate audio clips
 *   3. User selects one (or regenerates) to advance to the next step
 *   4. Selected audio becomes the source for the next step's lego layer
 *   5. Final step's selection is the finished track
 *
 * The component reads legoState from the store and dispatches
 * selectLegoCandidate / regenerateLegoCandidates actions.
 */

import React from 'react';
import {
  Layers,
  Loader2,
  RefreshCw,
  Check,
  Play,
  Music,
  Clock,
  MessageSquare,
  Sparkles,
} from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useAceStepStore } from '../store/acestepStore';
import type { GeneratedAudio, LegoStepPlan } from '../types';
import { AudioPlayer } from './AudioPlayer';
import './LegoFlowPanel.scss';

type TFunc = (key: string, opts?: { defaultValue?: string }) => string;

/** Format a step plan as a short label (e.g. "Step 2: vocals"). */
function stepLabel(index: number, plan: LegoStepPlan): string {
  const track = plan.track || 'base';
  return `Step ${index + 1}: ${track}`;
}

/** Render a single candidate card with player and select button. */
interface CandidateCardProps {
  candidate: GeneratedAudio;
  index: number;
  isSelected: boolean;
  disabled: boolean;
  onSelect: (index: number) => void;
  t: TFunc;
}

const CandidateCard: React.FC<CandidateCardProps> = ({
  candidate,
  index,
  isSelected,
  disabled,
  onSelect,
  t,
}) => {
  return (
    <div className={`lego-flow__candidate${isSelected ? ' is-selected' : ''}`}>
      <div className="lego-flow__candidate-header">
        <span className="lego-flow__candidate-label">
          {t('lego.candidate', { defaultValue: 'Candidate' })} {index + 1}
        </span>
        {isSelected && (
          <span className="lego-flow__candidate-badge">
            <Check size={11} />
            {t('lego.selected', { defaultValue: 'Selected' })}
          </span>
        )}
      </div>
      <div className="lego-flow__candidate-meta">
        <span className="lego-flow__candidate-duration">
          <Clock size={10} style={{ marginRight: 3, verticalAlign: 'middle' }} />
          {candidate.durationSeconds.toFixed(1)}s
        </span>
      </div>
      <div className="lego-flow__candidate-player">
        <AudioPlayer filePath={candidate.outputPath} />
      </div>
      <button
        type="button"
        className="lego-flow__candidate-select"
        onClick={() => onSelect(index)}
        disabled={disabled || isSelected}
      >
        {isSelected ? (
          <>
            <Check size={13} />
            {t('lego.selected', { defaultValue: 'Selected' })}
          </>
        ) : (
          <>
            <Play size={13} />
            {t('lego.selectThis', { defaultValue: 'Select' })}
          </>
        )}
      </button>
    </div>
  );
};

// ---- Main component ----

export const LegoFlowPanel: React.FC = () => {
  const { t } = useI18n('acestep');
  const legoState = useAceStepStore(
    (s) => s.activeSession?.legoState ?? null,
  );
  const generationState = useAceStepStore((s) => s.generationState);
  const progress = useAceStepStore((s) => s.progress);
  const error = useAceStepStore((s) => s.error);
  const selectLegoCandidate = useAceStepStore((s) => s.selectLegoCandidate);
  const regenerateLegoCandidates = useAceStepStore(
    (s) => s.regenerateLegoCandidates,
  );
  const generateLegoCandidates = useAceStepStore(
    (s) => s.generateLegoCandidates,
  );
  const updateLegoStepPlan = useAceStepStore((s) => s.updateLegoStepPlan);
  const callLyricsWriter = useAceStepStore((s) => s.callLyricsWriter);

  // Local state for the lyrics writer loading indicator.
  const [lyricsWriting, setLyricsWriting] = React.useState(false);

  const isGenerating =
    generationState === 'generating' || generationState === 'loading-models';

  // ---- Empty state: no plan yet ----
  if (!legoState) {
    return (
      <div className="lego-flow lego-flow--empty">
        <div className="lego-flow__empty-icon">
          <Layers size={24} />
        </div>
        <p>
          {t('lego.emptyHint', {
            defaultValue:
              'Describe the layered track you want to build. The LLM will plan each layer.',
          })}
        </p>
      </div>
    );
  }

  const currentStep = legoState.currentStep;
  const currentPlan = legoState.steps[currentStep];
  const currentCandidates = legoState.candidates[currentStep] ?? [];
  const isCompleted = legoState.phase === 'completed';

  /** Call the lyrics writer subagent to rewrite the current step's lyrics. */
  const handleRewriteLyrics = async () => {
    if (!currentPlan || lyricsWriting || isGenerating) return;
    setLyricsWriting(true);
    try {
      await callLyricsWriter({
        brief: '',
        existingLyrics: currentPlan.lyrics,
      });
    } finally {
      setLyricsWriting(false);
    }
  };
  // 'awaiting-plan' = waiting for user to describe the next layer in chat
  // 'asking' = LLM is asking the user a question (discussion phase)
  // 'planning' = LLM has proposed the current step; user can edit before generating
  // 'selecting' = candidates ready, user picks one
  const isAwaitingPlan =
    legoState.phase === 'awaiting-plan' || legoState.phase === 'asking';
  const isAsking = legoState.phase === 'asking';
  const isPlanning = legoState.phase === 'planning';
  const isSelecting = legoState.phase === 'selecting';
  // Step label shows "Step N" with no total — the count grows as layers are added.
  const stepCount = legoState.steps.length;

  return (
    <div className="lego-flow">
      {/* ---- Header ---- */}
      <div className="lego-flow__header">
        <span className="lego-flow__title">
          <Layers size={14} />
          {t('lego.title', { defaultValue: 'Lego Layered Creation' })}
        </span>
        <span className="lego-flow__progress">
          {isCompleted
            ? t('lego.done', { defaultValue: 'Done' })
            : isAwaitingPlan
              ? `${stepCount} ${t('lego.layers', { defaultValue: 'layers' })}`
              : `${t('lego.step', { defaultValue: 'Step' })} ${currentStep + 1}`}
        </span>
      </div>

      <div className="lego-flow__body">
        {/* ---- Step plan list (overview) ---- */}
        <div className="lego-flow__steps-overview">
          {legoState.steps.map((step, i) => {
            const isPast = i < currentStep || isCompleted;
            const isCurrent = i === currentStep && !isCompleted;
            const selectedIdx = legoState.selectedIndices[i];
            const hasSelection = selectedIdx !== undefined;
            return (
              <div
                key={i}
                className={`lego-flow__step-row${
                  isCurrent ? ' is-current' : ''
                }${isPast ? ' is-past' : ''}`}
              >
                <span className="lego-flow__step-index">
                  {isPast && hasSelection ? (
                    <Check size={11} />
                  ) : isCurrent ? (
                    <Loader2 size={11} className="spin" />
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="lego-flow__step-track">
                  {step.track || 'base'}
                </span>
                <span className="lego-flow__step-caption" title={step.caption}>
                  {step.caption}
                </span>
              </div>
            );
          })}
        </div>

        {/* ---- Awaiting plan / discussing: prompt user to describe next layer ---- */}
        {isAwaitingPlan && !isCompleted && (
          <div className="lego-flow__awaiting">
            <div className="lego-flow__awaiting-icon">
              <MessageSquare size={16} />
            </div>
            <p>
              {isAsking
                ? t('lego.discussing', {
                    defaultValue:
                      'Discussing with you in the chat — answer the question to continue.',
                  })
                : stepCount === 0
                  ? t('lego.awaitingFirst', {
                      defaultValue:
                        'Describe the song you want to build in the chat. The advisor will propose the base layer.',
                    })
                  : t('lego.awaitingNext', {
                      defaultValue:
                        'Describe the next layer to add (e.g. "add drums", "now vocals"). Say "done" when the track is finished.',
                    })}
            </p>
          </div>
        )}

        {/* ---- Current step detail ---- */}
        {currentPlan && !isCompleted && (
          <div className="lego-flow__current">
            <div className="lego-flow__current-header">
              {stepLabel(currentStep, currentPlan)}
            </div>

            {/* Duration: editable only for step 1 (base layer sets song length) */}
            {isPlanning && legoState.currentStep === 0 && (
              <div className="lego-flow__field lego-flow__field--duration">
                <label>
                  {t('lego.duration', { defaultValue: 'Duration (sec)' })}
                </label>
                <input
                  type="number"
                  min={0}
                  max={600}
                  step={10}
                  className="lego-flow__field-input lego-flow__field-input--number"
                  value={currentPlan.duration || 0}
                  onChange={(e) =>
                    updateLegoStepPlan({
                      duration: parseInt(e.target.value, 10) || 0,
                    })
                  }
                  disabled={isGenerating}
                />
              </div>
            )}
            {legoState.currentStep > 0 && currentPlan.duration === 0 && (
              <div className="lego-flow__field-hint">
                {t('lego.durationInherit', {
                  duration: legoState.steps[0]?.duration ?? 0,
                  defaultValue: 'Duration: inherits base layer ({{duration}}s)',
                })}
              </div>
            )}

            {/* Caption: editable in planning phase, read-only otherwise */}
            {isPlanning ? (
              <div className="lego-flow__field">
                <label>
                  {t('lego.caption', { defaultValue: 'Caption' })}
                </label>
                <textarea
                  className="lego-flow__field-input"
                  value={currentPlan.caption}
                  onChange={(e) =>
                    updateLegoStepPlan({ caption: e.target.value })
                  }
                  rows={3}
                  disabled={isGenerating}
                />
              </div>
            ) : (
              <div className="lego-flow__current-caption">
                {currentPlan.caption}
              </div>
            )}

            {/* Lyrics: editable in planning phase, read-only otherwise */}
            {isPlanning ? (
              <div className="lego-flow__field">
                <label className="lego-flow__field-label-row">
                  <span>{t('lego.lyrics', { defaultValue: 'Lyrics' })}</span>
                  <button
                    type="button"
                    className="lego-flow__ai-rewrite-btn"
                    onClick={handleRewriteLyrics}
                    disabled={lyricsWriting || isGenerating}
                    title={t('lego.rewriteLyrics', { defaultValue: 'AI rewrite lyrics' })}
                  >
                    {lyricsWriting ? (
                      <Loader2 size={11} className="lego-flow__spin" />
                    ) : (
                      <Sparkles size={11} />
                    )}
                    {t('lego.rewriteLyrics', { defaultValue: 'AI rewrite' })}
                  </button>
                </label>
                <textarea
                  className="lego-flow__field-input lego-flow__field-input--lyrics"
                  value={currentPlan.lyrics}
                  onChange={(e) =>
                    updateLegoStepPlan({ lyrics: e.target.value })
                  }
                  rows={8}
                  disabled={isGenerating}
                  placeholder={
                    currentPlan.track
                      ? t('lego.lyricsPlaceholderInstrumental', {
                          defaultValue: '[Instrumental] for non-vocal tracks',
                        })
                      : t('lego.lyricsPlaceholder', {
                          defaultValue: 'One line per phrase. Empty for instrumental.',
                        })
                  }
                />
              </div>
            ) : (
              currentPlan.lyrics && (
                <pre className="lego-flow__current-lyrics">
                  {currentPlan.lyrics}
                </pre>
              )
            )}

            {/* Reasoning: always read-only */}
            {currentPlan.reasoning && (
              <div className="lego-flow__current-reasoning">
                {currentPlan.reasoning}
              </div>
            )}

            {/* Start generation button (planning phase only) */}
            {isPlanning && (
              <button
                type="button"
                className="lego-flow__start-btn"
                onClick={() => generateLegoCandidates()}
                disabled={isGenerating}
              >
                {isGenerating ? (
                  <>
                    <Loader2 size={14} className="spin" />
                    {t('lego.generating', { defaultValue: 'Generating...' })}
                  </>
                ) : (
                  <>
                    <Play size={14} />
                    {t('lego.startGeneration', {
                      defaultValue: 'Generate 2 candidates',
                    })}
                  </>
                )}
              </button>
            )}
          </div>
        )}

        {/* ---- Generation progress ---- */}
        {isGenerating && progress && (
          <div className="lego-flow__progress-bar">
            <div className="lego-flow__progress-track">
              <div
                className="lego-flow__progress-fill"
                style={{
                  width: `${progress.total > 0 ? (progress.step / progress.total) * 100 : 0}%`,
                }}
              />
            </div>
            <span className="lego-flow__progress-text">
              {progress.stageName} {progress.step}/{progress.total}
            </span>
          </div>
        )}

        {/* ---- Error ---- */}
        {error && generationState === 'error' && (
          <div className="lego-flow__error">{error}</div>
        )}

        {/* ---- Candidates for current step (only in selecting phase) ---- */}
        {isSelecting && currentCandidates.length > 0 && (
          <div className="lego-flow__candidates">
            <div className="lego-flow__candidates-header">
              <span>
                {t('lego.candidates', { defaultValue: 'Candidates' })}
              </span>
              <button
                type="button"
                className="lego-flow__regen-btn"
                onClick={() => regenerateLegoCandidates()}
                disabled={isGenerating}
                title={t('lego.regenerate', {
                  defaultValue: 'Regenerate candidates',
                })}
              >
                <RefreshCw size={12} />
                {t('lego.regenerate', { defaultValue: 'Regenerate' })}
              </button>
            </div>
            <div className="lego-flow__candidates-list">
              {currentCandidates.map((c, i) => (
                <CandidateCard
                  key={c.id}
                  candidate={c}
                  index={i}
                  isSelected={legoState.selectedIndices[currentStep] === i}
                  disabled={isGenerating}
                  onSelect={selectLegoCandidate}
                  t={t}
                />
              ))}
            </div>
          </div>
        )}

        {/* ---- Completed: final output ---- */}
        {isCompleted && (
          <div className="lego-flow__final">
            <div className="lego-flow__final-header">
              <Music size={14} />
              {t('lego.finalTrack', { defaultValue: 'Final Track' })}
            </div>
            {legoState.baseAudioPath && (
              <div className="lego-flow__final-player">
                <AudioPlayer filePath={legoState.baseAudioPath} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
