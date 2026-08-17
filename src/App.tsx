import { useEffect, useMemo, useRef, useState } from "react";
import type { LanguageCode, ServerMessage, TranslationMode, UsageMetrics } from "../shared/protocol";
import { languageNames } from "../shared/protocol";
import { PcmPlayer, PcmRecorder } from "./audio";
import "./styles.css";

type Status = "idle" | "connecting" | "listening" | "stopping" | "error";
type Result = { id: number; original: string; translation: string };

const emptyMetrics: UsageMetrics = {
  audioSeconds: 0,
  firstResultMs: null,
  estimatedUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
};

export default function App() {
  const [mode, setMode] = useState<TranslationMode>("pipeline");
  const [sourceLanguage, setSourceLanguage] = useState<LanguageCode>("ja");
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>("en");
  const [status, setStatus] = useState<Status>("idle");
  const [provider, setProvider] = useState<"mock" | "openai" | null>(null);
  const [partialOriginal, setPartialOriginal] = useState("");
  const [partialTranslation, setPartialTranslation] = useState("");
  const [pendingOriginal, setPendingOriginal] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [metrics, setMetrics] = useState(emptyMetrics);
  const [error, setError] = useState("");
  const [inputLevel, setInputLevel] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef(new PcmRecorder());
  const playerRef = useRef(new PcmPlayer());
  const nextId = useRef(1);
  const pendingOriginalRef = useRef("");
  const partialOriginalRef = useRef("");
  const activeModeRef = useRef<TranslationMode | null>(null);
  const providerReadyRef = useRef(false);
  const audioQueueRef = useRef<string[]>([]);

  const busy = status !== "idle" && status !== "error";
  const statusText = useMemo(() => ({
    idle: "待機中",
    connecting: "接続中",
    listening: "翻訳中",
    stopping: "停止処理中",
    error: "エラー",
  }[status]), [status]);

  useEffect(() => () => {
    socketRef.current?.close();
    void recorderRef.current.stop();
    void playerRef.current.close();
  }, []);

  const handleServerMessage = async (message: ServerMessage) => {
    switch (message.type) {
      case "session.ready":
        setProvider(message.provider);
        activeModeRef.current = message.mode;
        if (message.mode === "pipeline") await playerRef.current.close();
        providerReadyRef.current = true;
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          for (const audio of audioQueueRef.current) {
            socketRef.current.send(JSON.stringify({ type: "audio.chunk", audio }));
          }
        }
        audioQueueRef.current = [];
        setStatus("listening");
        break;
      case "transcript.partial":
        partialOriginalRef.current += message.text;
        setPartialOriginal(partialOriginalRef.current);
        break;
      case "transcript.final":
        pendingOriginalRef.current = message.text;
        setPendingOriginal(message.text);
        partialOriginalRef.current = "";
        setPartialOriginal("");
        break;
      case "translation.partial":
        setPartialTranslation((current) => current + message.text);
        break;
      case "translation.final":
        setResults((current) => [
          { id: nextId.current++, original: pendingOriginalRef.current || partialOriginalRef.current || "（直接音声翻訳）", translation: message.text },
          ...current,
        ]);
        pendingOriginalRef.current = "";
        partialOriginalRef.current = "";
        setPendingOriginal("");
        setPartialTranslation("");
        break;
      case "turn.final":
        setResults((current) => [
          { id: nextId.current++, original: message.original, translation: message.translation },
          ...current,
        ]);
        if (pendingOriginalRef.current === message.original) {
          pendingOriginalRef.current = "";
          setPendingOriginal("");
        }
        setPartialTranslation("");
        break;
      case "audio.delta":
        if (activeModeRef.current === "direct") await playerRef.current.append(message.audio);
        break;
      case "metrics":
        setMetrics(message.metrics);
        break;
      case "session.error":
        providerReadyRef.current = false;
        audioQueueRef.current = [];
        setError(message.message);
        setStatus("error");
        await recorderRef.current.stop();
        break;
      case "session.stopped":
        setStatus("idle");
        break;
    }
  };

  const start = async () => {
    activeModeRef.current = mode;
    providerReadyRef.current = false;
    audioQueueRef.current = [];
    setError("");
    setInputLevel(0);
    setMetrics(emptyMetrics);
    setPartialOriginal("");
    setPartialTranslation("");
    setPendingOriginal("");
    pendingOriginalRef.current = "";
    partialOriginalRef.current = "";
    setStatus("connecting");

    try {
      await recorderRef.current.start((audio, speechActive) => {
        if (activeModeRef.current === "pipeline" && !speechActive) return;
        if (providerReadyRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({ type: "audio.chunk", audio }));
        } else {
          audioQueueRef.current.push(audio);
          if (audioQueueRef.current.length > 30) audioQueueRef.current.shift();
        }
      }, setInputLevel, () => {
        if (
          activeModeRef.current === "pipeline" &&
          providerReadyRef.current &&
          socketRef.current?.readyState === WebSocket.OPEN
        ) {
          socketRef.current.send(JSON.stringify({ type: "audio.commit" }));
        }
      });
    } catch {
      setError("マイクを開始できません。ブラウザとWindowsのマイク権限を確認してください。");
      setStatus("error");
      return;
    }

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socketRef.current = socket;
    socket.onopen = () => socket.send(JSON.stringify({
      type: "session.start",
      options: { mode, sourceLanguage, targetLanguage },
    }));
    socket.onmessage = (event) => void handleServerMessage(JSON.parse(event.data) as ServerMessage);
    socket.onerror = () => {
      setError("サーバーへ接続できません。サーバーが起動しているか確認してください。");
      setStatus("error");
    };
    socket.onclose = () => {
      providerReadyRef.current = false;
      audioQueueRef.current = [];
      void recorderRef.current.stop();
      setInputLevel(0);
      setStatus((current) => current === "error" ? "error" : "idle");
    };
  };

  const stop = async () => {
    setStatus("stopping");
    providerReadyRef.current = false;
    audioQueueRef.current = [];
    await recorderRef.current.stop();
    setInputLevel(0);
    socketRef.current?.send(JSON.stringify({ type: "session.stop" }));
    setTimeout(() => socketRef.current?.close(), 1_000);
  };

  const swapLanguages = () => {
    setSourceLanguage(targetLanguage);
    setTargetLanguage(sourceLanguage);
  };

  return (
    <main>
      <header className="hero">
        <div className="brand-mark">翻</div>
        <div>
          <p className="eyebrow">LIVE INTERPRETER</p>
          <h1>翻訳こんにゃく</h1>
          <p className="subtitle">話した言葉を、間を置かずに向こう側へ。</p>
        </div>
        <div className={`status status-${status}`}><span />{statusText}</div>
      </header>

      <section className="control-card">
        <div className="mode-picker" aria-label="翻訳方式">
          <button className={mode === "pipeline" ? "active" : ""} disabled={busy} onClick={() => setMode("pipeline")}>
            <strong>分離型</strong><span>文字起こし ＋ AI翻訳</span><em>比較的安価・原文を確認</em>
          </button>
          <button className={mode === "direct" ? "active" : ""} disabled={busy} onClick={() => setMode("direct")}>
            <strong>一括型</strong><span>リアルタイム音声翻訳</span><em>低遅延・翻訳音声つき</em>
          </button>
        </div>

        <div className="language-row">
          <label>話す言語<select disabled={busy} value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value as LanguageCode)}>{Object.entries(languageNames).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
          <button className="swap" disabled={busy} onClick={swapLanguages} aria-label="言語を入れ替える">⇄</button>
          <label>翻訳先<select disabled={busy} value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value as LanguageCode)}>{Object.entries(languageNames).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
        </div>

        <button className={`record ${status === "listening" ? "recording" : ""}`} disabled={status === "connecting" || status === "stopping"} onClick={status === "listening" ? stop : start}>
          <span className="record-icon" />
          {status === "listening" ? "翻訳を停止" : "翻訳を開始"}
        </button>
        <div className="input-meter" aria-label={`マイク入力レベル ${Math.round(inputLevel * 100)}%`}>
          <span>マイク入力</span>
          <div><i style={{ width: `${Math.round(inputLevel * 100)}%` }} /></div>
          <strong>{Math.round(inputLevel * 100)}%</strong>
        </div>
        {provider === "mock" && <p className="mock-note">デモモード：APIキー設定後に実際の音声を翻訳します</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <section className="workspace">
        <div className="transcript-card">
          <div className="section-heading">
            <div><h2>会話</h2><p>最新の発話を上に表示</p></div>
            <button onClick={() => setResults([])} disabled={!results.length}>クリア</button>
          </div>
          {!results.length && !partialOriginal && !pendingOriginal && !partialTranslation ? (
            <div className="empty"><div className="wave"><i/><i/><i/><i/><i/></div><p>翻訳を開始して話しかけてください</p></div>
          ) : (
            <>
              {(partialOriginal || pendingOriginal || partialTranslation) && (
                <article className="live-turn">
                  <div className="turn-heading"><strong>いまの発話</strong><span>{partialTranslation ? "翻訳中…" : "認識中…"}</span></div>
                  <div className="utterance original"><small>原文 · {languageNames[sourceLanguage]}</small><p>{partialOriginal || pendingOriginal || "音声を認識しています…"}</p></div>
                  <div className="utterance translation"><small>翻訳 · {languageNames[targetLanguage]}</small><p>{partialTranslation || "翻訳を待っています…"}</p></div>
                </article>
              )}
              {!!results.length && (
                <div className="results">
                  <p className="history-label">確定履歴 · 新しい順</p>
                  {results.map((result) => (
                    <article key={result.id}>
                      <div className="utterance original"><small>原文 · {languageNames[sourceLanguage]}</small><p>{result.original}</p></div>
                      <div className="utterance translation"><small>翻訳 · {languageNames[targetLanguage]}</small><p>{result.translation}</p></div>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <aside className="metrics-card">
          <p className="eyebrow">SESSION METRICS</p>
          <dl>
            <div><dt>音声時間</dt><dd>{metrics.audioSeconds.toFixed(1)}<small>秒</small></dd></div>
            <div><dt>初回結果</dt><dd>{metrics.firstResultMs === null ? "—" : metrics.firstResultMs}<small>ms</small></dd></div>
            <div><dt>推定料金</dt><dd>${metrics.estimatedUsd.toFixed(4)}</dd></div>
            <div><dt>テキストトークン</dt><dd>{metrics.inputTokens + metrics.outputTokens}</dd></div>
          </dl>
          <p className="model-label">使用モデル</p>
          <code>{mode === "pipeline" ? "gpt-live-transcribe\n+ gpt-5-mini" : "gpt-realtime-translate"}</code>
        </aside>
      </section>
    </main>
  );
}
