import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config } from "dotenv";
import Fastify from "fastify";
import OpenAI from "openai";
import { resolve } from "node:path";
import type { ClientMessage, ServerMessage, SessionOptions } from "../shared/protocol.js";
import { calculateMetrics } from "./metrics.js";
import { OpenAIRealtimeSession } from "./openai-realtime.js";

config({ path: resolve(process.cwd(), "..", ".env"), override: false });

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(websocket);

const provider = process.env.TRANSLATION_PROVIDER === "openai" ? "openai" : "mock";
const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

app.get("/api/health", async () => ({
  ok: true,
  provider,
  apiKeyConfigured: Boolean(apiKey),
}));

app.get("/ws", { websocket: true }, (socket) => {
  let options: SessionOptions | null = null;
  let realtime: OpenAIRealtimeSession | null = null;
  let startedAt = 0;
  let firstResultMs: number | null = null;
  let audioBytes = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let mockChunks = 0;

  const emit = (message: ServerMessage) => {
    if (firstResultMs === null && ["transcript.partial", "translation.partial", "translation.final"].includes(message.type)) {
      firstResultMs = Date.now() - startedAt;
    }
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  const emitMetrics = () => {
    if (!options) return;
    emit({ type: "metrics", metrics: calculateMetrics(options.mode, audioBytes, firstResultMs, inputTokens, outputTokens) });
  };

  const translate = async (text: string) => {
    if (!options || !openai) return;
    const response = await openai.responses.create({
      model: process.env.OPENAI_TRANSLATE_MODEL ?? "gpt-5-mini",
      reasoning: { effort: "minimal" },
      input: [
        {
          role: "developer",
          content: `You are a live interpreter. Translate from ${options.sourceLanguage} to ${options.targetLanguage}. Return only the natural translation. Preserve names, numbers, intent, and tone.`,
        },
        { role: "user", content: text },
      ],
    });
    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;
    emit({ type: "translation.final", text: response.output_text.trim() });
    emitMetrics();
  };

  socket.on("message", async (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      emit({ type: "session.error", message: "不正なメッセージを受信しました。", recoverable: true });
      return;
    }

    if (message.type === "session.start") {
      options = message.options;
      startedAt = Date.now();
      if (options.sourceLanguage === options.targetLanguage) {
        emit({ type: "session.error", message: "入力言語と翻訳先言語を変えてください。", recoverable: true });
        return;
      }
      if (provider === "openai") {
        if (!apiKey) {
          emit({ type: "session.error", message: "OPENAI_API_KEYが設定されていません。", recoverable: false });
          return;
        }
        realtime = new OpenAIRealtimeSession(apiKey, options, emit, translate);
        try {
          await realtime.connect();
        } catch (error) {
          emit({ type: "session.error", message: error instanceof Error ? error.message : "OpenAIへ接続できません。", recoverable: false });
          return;
        }
      }
      emit({ type: "session.ready", mode: options.mode, provider });
      return;
    }

    if (message.type === "audio.chunk" && options) {
      audioBytes += Math.floor((message.audio.length * 3) / 4);
      if (provider === "openai") {
        realtime?.appendAudio(message.audio);
      } else {
        mockChunks += 1;
        if (mockChunks === 8) emit({ type: "transcript.partial", text: "今日はリアルタイム翻訳の" });
        if (mockChunks === 16) {
          emit({ type: "transcript.final", text: "今日はリアルタイム翻訳のテストをしています。" });
          emit({ type: "translation.final", text: "We are testing real-time translation today." });
        }
      }
      if (mockChunks % 10 === 0) emitMetrics();
      return;
    }

    if (message.type === "session.stop") {
      realtime?.stop();
      emitMetrics();
      emit({ type: "session.stopped" });
    }
  });

  socket.on("close", () => realtime?.stop());
});

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: "127.0.0.1" });
