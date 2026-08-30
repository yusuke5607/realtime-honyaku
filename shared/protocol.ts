export type AudioChannel = "remote" | "local";
export type TranslationMode = "pipeline" | "direct";
export type LanguageCode = "ja" | "en" | "ko" | "zh" | "es" | "fr" | "de";

export interface SessionOptions {
  localLanguage: LanguageCode;
  remoteLanguage: LanguageCode;
}

export type ClientMessage =
  | { type: "session.start"; options: SessionOptions; accessToken?: string }
  | { type: "audio.chunk"; channel: AudioChannel; audio: string }
  | { type: "audio.commit"; channel: AudioChannel }
  | { type: "session.stop" };

export interface UsageMetrics {
  audioSeconds: number;
  firstResultMs: number | null;
  estimatedUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export type ServerMessage =
  | { type: "session.ready"; provider: "mock" | "openai" }
  | { type: "transcript.partial"; channel: AudioChannel; text: string }
  | { type: "transcript.final"; channel: AudioChannel; text: string }
  | { type: "turn.final"; channel: AudioChannel; original: string; translation: string }
  | { type: "audio.file"; channel: AudioChannel; audio: string; mimeType: "audio/mpeg" }
  | { type: "metrics"; metrics: UsageMetrics }
  | { type: "session.stopped" }
  | { type: "session.error"; channel?: AudioChannel; message: string; recoverable: boolean };

export const languageNames: Record<LanguageCode, string> = {
  ja: "日本語", en: "英語", ko: "韓国語", zh: "中国語",
  es: "スペイン語", fr: "フランス語", de: "ドイツ語",
};
