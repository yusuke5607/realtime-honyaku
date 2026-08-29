import WebSocket from "ws";
import type { AudioChannel, LanguageCode, ServerMessage } from "../shared/protocol.js";

type Emit = (message: ServerMessage) => void;
type FinalTranscript = (channel: AudioChannel, text: string) => Promise<void>;

export class OpenAIRealtimeSession {
  private socket: WebSocket | null = null;
  private pendingAudioBytes = 0;

  constructor(
    private readonly apiKey: string,
    private readonly channel: AudioChannel,
    private readonly language: LanguageCode,
    private readonly emit: Emit,
    private readonly onFinalTranscript: FinalTranscript,
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      this.socket = socket;
      const timeout = setTimeout(() => reject(new Error("OpenAIへの接続がタイムアウトしました。")), 15_000);
      socket.once("open", () => this.configure());
      socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
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
        } catch { /* malformed provider event */ }
      });
      socket.on("close", (code, reason) => {
        if (code !== 1000) this.emit({
          type: "session.error", channel: this.channel,
          message: `OpenAI接続が終了しました (${code}): ${reason.toString() || "理由不明"}`,
          recoverable: false,
        });
      });
    });
  }

  appendAudio(audio: string): void {
    this.send({ type: "input_audio_buffer.append", audio });
    this.pendingAudioBytes += Math.floor((audio.length * 3) / 4);
  }

  commitAudio(): void {
    if (this.pendingAudioBytes >= 4_800) {
      this.send({ type: "input_audio_buffer.commit" });
      this.pendingAudioBytes = 0;
    }
  }

  stop(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.commitAudio();
      setTimeout(() => this.socket?.close(1000), 800);
    }
  }

  private configure(): void {
    this.send({ type: "session.update", session: {
      type: "transcription",
      audio: { input: {
        format: { type: "audio/pcm", rate: 24_000 },
        transcription: {
          model: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-transcribe",
          languages: [this.language], delay: "low",
        },
        turn_detection: null,
      } },
    } });
  }

  private handleEvent(raw: string): void {
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    const type = String(event.type ?? "");
    const text = String(event.delta ?? event.transcript ?? "");
    if (type.includes("transcription") && type.endsWith("delta") && text) {
      this.emit({ type: "transcript.partial", channel: this.channel, text });
    } else if (type.includes("transcription") && type.endsWith("completed") && text) {
      this.emit({ type: "transcript.final", channel: this.channel, text });
      void this.onFinalTranscript(this.channel, text);
    } else if (type === "error") {
      const error = event.error as { message?: string } | undefined;
      this.emit({ type: "session.error", channel: this.channel, message: error?.message ?? "OpenAI APIエラー", recoverable: false });
    }
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }
}
