export type TranslationMode = "pipeline" | "direct";

export type LanguageCode = "ja" | "en" | "ko" | "zh" | "es" | "fr" | "de";

export interface SessionOptions {
  mode: TranslationMode;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
}

export type ClientMessage =
  | { type: "session.start"; options: SessionOptions }
  | { type: "audio.chunk"; audio: string }
  | { type: "session.stop" };

export interface UsageMetrics {
  audioSeconds: number;
  firstResultMs: number | null;
  estimatedUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export type ServerMessage =
  | { type: "session.ready"; mode: TranslationMode; provider: "mock" | "openai" }
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; text: string }
  | { type: "translation.partial"; text: string }
  | { type: "translation.final"; text: string }
  | { type: "audio.delta"; audio: string }
  | { type: "metrics"; metrics: UsageMetrics }
  | { type: "session.stopped" }
  | { type: "session.error"; message: string; recoverable: boolean };

export const languageNames: Record<LanguageCode, string> = {
  ja: "日本語",
  en: "英語",
  ko: "韓国語",
  zh: "中国語",
  es: "スペイン語",
  fr: "フランス語",
  de: "ドイツ語",
};
