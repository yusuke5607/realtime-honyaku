import WebSocket from "ws";
import type { LanguageCode, ServerMessage, SessionOptions } from "../shared/protocol.js";

type Emit = (message: ServerMessage) => void;
type FinalTranscript = (text: string) => Promise<void>;

const languageLabels: Record<LanguageCode, string> = {
  ja: "Japanese",
  en: "English",
  ko: "Korean",
  zh: "Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
};

export class OpenAIRealtimeSession {
  private socket: WebSocket | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly options: SessionOptions,
    private readonly emit: Emit,
    private readonly onFinalTranscript: FinalTranscript,
  ) {}

  async connect(): Promise<void> {
    const model =
      this.options.mode === "pipeline"
        ? process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-realtime-whisper"
        : process.env.OPENAI_DIRECT_MODEL ?? "gpt-realtime-translate";
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });
      this.socket = socket;
      const timeout = setTimeout(() => reject(new Error("OpenAIへの接続がタイムアウトしました。")), 15_000);

      socket.once("open", () => {
        clearTimeout(timeout);
        this.configure();
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.on("message", (data) => this.handleEvent(data.toString()));
      socket.on("close", (code, reason) => {
        if (code !== 1000) {
          this.emit({
            type: "session.error",
            message: `OpenAI接続が終了しました (${code}): ${reason.toString() || "理由不明"}`,
            recoverable: false,
          });
        }
      });
    });
  }

  appendAudio(audio: string): void {
    this.send({ type: "input_audio_buffer.append", audio });
  }

  stop(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "input_audio_buffer.commit" });
      setTimeout(() => this.socket?.close(1000), 800);
    }
  }

  private configure(): void {
    const input = languageLabels[this.options.sourceLanguage];
    const output = languageLabels[this.options.targetLanguage];

    if (this.options.mode === "pipeline") {
      this.send({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: {
                model: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-realtime-whisper",
                language: this.options.sourceLanguage,
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 650,
              },
            },
          },
        },
      });
      return;
    }

    this.send({
      type: "session.update",
      session: {
        type: "translation",
        source_language: this.options.sourceLanguage,
        target_language: this.options.targetLanguage,
        instructions: `Translate spoken ${input} into natural ${output}. Preserve meaning, names, numbers, and tone.`,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            turn_detection: { type: "server_vad", silence_duration_ms: 650 },
          },
          output: { format: { type: "audio/pcm", rate: 24_000 }, voice: "marin" },
        },
      },
    });
  }

  private handleEvent(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(event.type ?? "");
    const text = String(event.delta ?? event.transcript ?? "");

    if (type.includes("transcription") && type.endsWith("delta") && text) {
      this.emit({ type: "transcript.partial", text });
    } else if (type.includes("transcription") && type.endsWith("completed") && text) {
      this.emit({ type: "transcript.final", text });
      if (this.options.mode === "pipeline") void this.onFinalTranscript(text);
    } else if ((type.includes("translation") || type.includes("audio_transcript")) && type.endsWith("delta") && text) {
      this.emit({ type: "translation.partial", text });
    } else if ((type.includes("translation") || type.includes("audio_transcript")) && type.endsWith("done") && text) {
      this.emit({ type: "translation.final", text });
    } else if (type.includes("audio") && type.endsWith("delta") && typeof event.delta === "string") {
      this.emit({ type: "audio.delta", audio: event.delta });
    } else if (type === "error") {
      const error = event.error as { message?: string } | undefined;
      this.emit({ type: "session.error", message: error?.message ?? "OpenAI APIエラー", recoverable: false });
    }
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }
}
