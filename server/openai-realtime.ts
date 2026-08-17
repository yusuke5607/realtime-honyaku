import WebSocket from "ws";
import type { ServerMessage, SessionOptions } from "../shared/protocol.js";

type Emit = (message: ServerMessage) => void;
type FinalTranscript = (text: string) => Promise<void>;

export class OpenAIRealtimeSession {
  private socket: WebSocket | null = null;
  private pendingAudioBytes = 0;

  constructor(
    private readonly apiKey: string,
    private readonly options: SessionOptions,
    private readonly emit: Emit,
    private readonly onFinalTranscript: FinalTranscript,
  ) {}

  async connect(): Promise<void> {
    const model = this.options.mode === "pipeline"
      ? process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-live-transcribe"
      : process.env.OPENAI_DIRECT_MODEL ?? "gpt-realtime-translate";
    const url = this.options.mode === "direct"
      ? `wss://api.openai.com/v1/realtime/translations?model=${encodeURIComponent(model)}`
      : "wss://api.openai.com/v1/realtime?intent=transcription";

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      this.socket = socket;
      const timeout = setTimeout(() => reject(new Error("OpenAIへの接続がタイムアウトしました。")), 15_000);

      socket.once("open", () => {
        this.configure();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.on("message", (data) => {
        const raw = data.toString();
        this.handleEvent(raw);
        try {
          const event = JSON.parse(raw) as { type?: string; error?: { message?: string } };
          if (event.type === "session.updated" || event.type === "transcription_session.updated") {
            clearTimeout(timeout);
            resolve();
          } else if (event.type === "error") {
            clearTimeout(timeout);
            reject(new Error(event.error?.message ?? "OpenAI session configuration failed"));
          }
        } catch {
          // The normal event handler ignores malformed provider events.
        }
      });
      socket.on("close", (code, reason) => {
        if (code !== 1000) {
          this.emit({
            type: "session.error",
            message: `OpenAI接続が終了しました [${this.options.mode}/${model}] (${code}): ${reason.toString() || "理由不明"}`,
            recoverable: false,
          });
        }
      });
    });
  }

  appendAudio(audio: string): void {
    const type = this.options.mode === "direct"
      ? "session.input_audio_buffer.append"
      : "input_audio_buffer.append";
    this.send({ type, audio });

    if (this.options.mode === "pipeline") {
      this.pendingAudioBytes += Math.floor((audio.length * 3) / 4);
    }
  }

  commitAudio(): void {
    if (this.options.mode === "pipeline" && this.pendingAudioBytes >= 24_000 * 2 * 0.1) {
      this.send({ type: "input_audio_buffer.commit" });
      this.pendingAudioBytes = 0;
    }
  }

  stop(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      if (this.options.mode === "direct") {
        this.send({ type: "session.close" });
        setTimeout(() => this.socket?.close(1000), 5_000);
      } else {
        this.commitAudio();
        setTimeout(() => this.socket?.close(1000), 800);
      }
    }
  }

  private configure(): void {
    if (this.options.mode === "pipeline") {
      this.send({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: {
                model: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-live-transcribe",
                languages: [this.options.sourceLanguage],
                delay: "low",
              },
              turn_detection: null,
            },
          },
        },
      });
      return;
    }

    this.send({
      type: "session.update",
      session: {
        audio: {
          output: { language: this.options.targetLanguage },
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

    if (type === "session.closed") {
      this.socket?.close(1000);
      return;
    }
    if (type === "session.input_transcript.delta" && text) {
      this.emit({ type: "transcript.partial", text });
      return;
    }
    if ((type === "session.input_transcript.done" || type === "session.input_transcript.completed") && text) {
      this.emit({ type: "transcript.final", text });
      return;
    }
    if (type === "session.output_transcript.delta" && text) {
      this.emit({ type: "translation.partial", text });
      return;
    }
    if ((type === "session.output_transcript.done" || type === "session.output_transcript.completed") && text) {
      this.emit({ type: "translation.final", text });
      return;
    }
    if (type === "session.output_audio.delta" && typeof event.delta === "string") {
      this.emit({ type: "audio.delta", audio: event.delta });
      return;
    }

    if (type.includes("transcription") && type.endsWith("delta") && text) {
      this.emit({ type: "transcript.partial", text });
    } else if (type.includes("transcription") && type.endsWith("completed") && text) {
      this.emit({ type: "transcript.final", text });
      if (this.options.mode === "pipeline") void this.onFinalTranscript(text);
    } else if ((type.includes("translation") || type.includes("audio_transcript")) && type.endsWith("delta") && text) {
      this.emit({ type: "translation.partial", text });
    } else if ((type.includes("translation") || type.includes("audio_transcript")) && type.endsWith("done") && text) {
      this.emit({ type: "translation.final", text });
    } else if (this.options.mode === "direct" && type.includes("audio") && type.endsWith("delta") && typeof event.delta === "string") {
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
