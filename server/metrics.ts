import type { TranslationMode, UsageMetrics } from "../shared/protocol.js";

// Transcription plus synthesized output, rounded upward for a conservative UI estimate.
const PIPELINE_AUDIO_PER_MINUTE = 0.02;
const DIRECT_AUDIO_PER_MINUTE = 0.034;
const TEXT_INPUT_PER_TOKEN = 0.25 / 1_000_000;
const TEXT_OUTPUT_PER_TOKEN = 2 / 1_000_000;

export function calculateMetrics(
  mode: TranslationMode,
  audioBytes: number,
  firstResultMs: number | null,
  inputTokens = 0,
  outputTokens = 0,
): UsageMetrics {
  const audioSeconds = audioBytes / 2 / 24_000;
  const audioPrice =
    (audioSeconds / 60) *
    (mode === "pipeline" ? PIPELINE_AUDIO_PER_MINUTE : DIRECT_AUDIO_PER_MINUTE);
  const textPrice =
    mode === "pipeline"
      ? inputTokens * TEXT_INPUT_PER_TOKEN + outputTokens * TEXT_OUTPUT_PER_TOKEN
      : 0;

  return {
    audioSeconds,
    firstResultMs,
    estimatedUsd: audioPrice + textPrice,
    inputTokens,
    outputTokens,
  };
}
