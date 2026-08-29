import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config } from "dotenv";
import Fastify from "fastify";
import OpenAI from "openai";
import { resolve } from "node:path";
import type { AudioChannel, ClientMessage, LanguageCode, ServerMessage, SessionOptions } from "../shared/protocol.js";
import { calculateMetrics } from "./metrics.js";
import { OpenAIRealtimeSession } from "./openai-realtime.js";

config({ path: resolve(process.cwd(), "..", ".env"), override: false });
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(websocket);

const provider = process.env.TRANSLATION_PROVIDER === "openai" ? "openai" : "mock";
const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

app.get("/api/health", async () => ({ ok: true, provider, apiKeyConfigured: Boolean(apiKey) }));

app.get("/ws", { websocket: true }, (socket) => {
  let options: SessionOptions | null = null;
  const sessions = new Map<AudioChannel, OpenAIRealtimeSession>();
  const queues: Record<AudioChannel, Promise<void>> = { remote: Promise.resolve(), local: Promise.resolve() };
  let startedAt = 0;
  let firstResultMs: number | null = null;
  let audioBytes = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const emit = (message: ServerMessage) => {
    if (firstResultMs === null && (message.type === "transcript.partial" || message.type === "turn.final")) {
      firstResultMs = Date.now() - startedAt;
    }
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const emitMetrics = () => emit({
    type: "metrics",
    metrics: calculateMetrics("pipeline", audioBytes, firstResultMs, inputTokens, outputTokens),
  });

  const languagesFor = (channel: AudioChannel): [LanguageCode, LanguageCode] => {
    if (!options) throw new Error("Session has not started");
    return channel === "remote"
      ? [options.remoteLanguage, options.localLanguage]
      : [options.localLanguage, options.remoteLanguage];
  };

  const translateAndSpeak = async (channel: AudioChannel, text: string) => {
    if (!openai) return;
    const [source, target] = languagesFor(channel);
    const response = await openai.responses.create({
      model: process.env.OPENAI_TRANSLATE_MODEL ?? "gpt-4o-mini",
      input: [
        { role: "developer", content: `Translate spoken ${source} into natural spoken ${target}. Return only the translation. Preserve names, numbers, intent, and tone.` },
        { role: "user", content: text },
      ],
    });
    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;
    const translation = response.output_text.trim();
    if (!translation) return;
    emit({ type: "turn.final", channel, original: text, translation });

    const speech = await openai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
      voice: process.env.OPENAI_TTS_VOICE ?? "alloy",
      input: translation,
      response_format: "mp3",
    });
    const audio = Buffer.from(await speech.arrayBuffer()).toString("base64");
    emit({ type: "audio.file", channel, audio, mimeType: "audio/mpeg" });
    emitMetrics();
  };

  const onFinalTranscript = async (channel: AudioChannel, text: string) => {
    queues[channel] = queues[channel]
      .then(() => translateAndSpeak(channel, text))
      .catch((error) => emit({ type: "session.error", channel, message: error instanceof Error ? error.message : "翻訳または音声合成に失敗しました。", recoverable: true }));
    await queues[channel];
  };

  socket.on("message", async (raw) => {
    let message: ClientMessage;
    try { message = JSON.parse(raw.toString()) as ClientMessage; }
    catch { emit({ type: "session.error", message: "不正なメッセージを受信しました。", recoverable: true }); return; }

    if (message.type === "session.start") {
      options = message.options;
      startedAt = Date.now();
      if (options.localLanguage === options.remoteLanguage) {
        emit({ type: "session.error", message: "自分と相手の言語を変えてください。", recoverable: true }); return;
      }
      if (provider === "openai") {
        if (!apiKey) { emit({ type: "session.error", message: "OPENAI_API_KEYが設定されていません。", recoverable: false }); return; }
        const remote = new OpenAIRealtimeSession(apiKey, "remote", options.remoteLanguage, emit, onFinalTranscript);
        const local = new OpenAIRealtimeSession(apiKey, "local", options.localLanguage, emit, onFinalTranscript);
        sessions.set("remote", remote); sessions.set("local", local);
        try { await Promise.all([remote.connect(), local.connect()]); }
        catch (error) { sessions.forEach((session) => session.stop()); emit({ type: "session.error", message: error instanceof Error ? error.message : "OpenAIへ接続できません。", recoverable: false }); return; }
      }
      emit({ type: "session.ready", provider });
      return;
    }
    if (message.type === "audio.chunk" && options) {
      audioBytes += Math.floor((message.audio.length * 3) / 4);
      sessions.get(message.channel)?.appendAudio(message.audio);
      return;
    }
    if (message.type === "audio.commit") { sessions.get(message.channel)?.commitAudio(); return; }
    if (message.type === "session.stop") {
      sessions.forEach((session) => session.stop());
      emitMetrics(); emit({ type: "session.stopped" });
    }
  });
  socket.on("close", () => sessions.forEach((session) => session.stop()));
});

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: "127.0.0.1" });
