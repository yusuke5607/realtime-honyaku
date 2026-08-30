import { useEffect, useRef, useState } from "react";
import type { AudioChannel, LanguageCode, ServerMessage, UsageMetrics } from "../shared/protocol";
import { languageNames } from "../shared/protocol";
import { AudioFilePlayer, PcmRecorder } from "./audio";
import "./styles.css";

type Status = "idle" | "connecting" | "listening" | "stopping" | "error";
type Result = { id: number; channel: AudioChannel; original: string; translation: string };
type PartialState = Record<AudioChannel, string>;

const emptyMetrics: UsageMetrics = { audioSeconds: 0, firstResultMs: null, estimatedUsd: 0, inputTokens: 0, outputTokens: 0 };
const emptyPartial = (): PartialState => ({ remote: "", local: "" });

export default function App() {
  const [localLanguage, setLocalLanguage] = useState<LanguageCode>("ja");
  const [remoteLanguage, setRemoteLanguage] = useState<LanguageCode>("en");
  const [status, setStatus] = useState<Status>("idle");
  const [results, setResults] = useState<Result[]>([]);
  const [partial, setPartial] = useState<PartialState>(emptyPartial);
  const [levels, setLevels] = useState<Record<AudioChannel, number>>({ remote: 0, local: 0 });
  const [metrics, setMetrics] = useState(emptyMetrics);
  const [error, setError] = useState("");
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [outgoingSinkId, setOutgoingSinkId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const recorders = useRef<Record<AudioChannel, PcmRecorder>>({ remote: new PcmRecorder(), local: new PcmRecorder() });
  const players = useRef<Record<AudioChannel, AudioFilePlayer>>({ remote: new AudioFilePlayer(), local: new AudioFilePlayer() });
  const readyRef = useRef(false);
  const queues = useRef<Record<AudioChannel, string[]>>({ remote: [], local: [] });
  const partialRef = useRef<PartialState>(emptyPartial());
  const nextId = useRef(1);
  const busy = status === "connecting" || status === "listening" || status === "stopping";

  useEffect(() => () => {
    socketRef.current?.close();
    void recorders.current.remote.stop(); void recorders.current.local.stop();
    players.current.remote.close(); players.current.local.close();
  }, []);

  useEffect(() => { players.current.local.setSinkId(outgoingSinkId); }, [outgoingSinkId]);

  useEffect(() => {
    void fetch("/api/health")
      .then((response) => response.json() as Promise<{ authRequired?: boolean }>)
      .then((health) => setAuthRequired(Boolean(health.authRequired)))
      .catch(() => undefined);
  }, []);

  const sendAudio = (channel: AudioChannel, audio: string, speechActive: boolean) => {
    if (!speechActive) return;
    if (readyRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "audio.chunk", channel, audio }));
    } else {
      queues.current[channel].push(audio);
      if (queues.current[channel].length > 40) queues.current[channel].shift();
    }
  };

  const commit = (channel: AudioChannel) => {
    if (readyRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "audio.commit", channel }));
    }
  };

  const handleMessage = (message: ServerMessage) => {
    if (message.type === "session.ready") {
      readyRef.current = true;
      for (const channel of ["remote", "local"] as const) {
        const buffered = queues.current[channel].length > 0;
        for (const audio of queues.current[channel]) socketRef.current?.send(JSON.stringify({ type: "audio.chunk", channel, audio }));
        if (buffered) socketRef.current?.send(JSON.stringify({ type: "audio.commit", channel }));
        queues.current[channel] = [];
      }
      setStatus("listening");
    } else if (message.type === "transcript.partial") {
      partialRef.current[message.channel] += message.text;
      setPartial({ ...partialRef.current });
    } else if (message.type === "transcript.final") {
      partialRef.current[message.channel] = message.text;
      setPartial({ ...partialRef.current });
    } else if (message.type === "turn.final") {
      setResults((current) => [{ id: nextId.current++, ...message }, ...current]);
      partialRef.current[message.channel] = "";
      setPartial({ ...partialRef.current });
    } else if (message.type === "audio.file") {
      players.current[message.channel].append(message.audio, message.mimeType);
    } else if (message.type === "metrics") setMetrics(message.metrics);
    else if (message.type === "session.error") { setError(message.message); if (!message.recoverable) setStatus("error"); }
    else if (message.type === "session.stopped") setStatus("idle");
  };

  const start = async () => {
    if (authRequired && !accessToken) {
      setError("アクセスキーを入力してください。");
      return;
    }
    setError(""); setMetrics(emptyMetrics); setStatus("connecting");
    readyRef.current = false; queues.current = { remote: [], local: [] };
    partialRef.current = emptyPartial(); setPartial(emptyPartial());
    try {
      await Promise.all([
        recorders.current.remote.start("meeting-tab", (audio, active) => sendAudio("remote", audio, active), (level) => setLevels((v) => ({ ...v, remote: level })), () => commit("remote")),
        recorders.current.local.start("microphone", (audio, active) => sendAudio("local", audio, active), (level) => setLevels((v) => ({ ...v, local: level })), () => commit("local")),
      ]);
      const devices = await navigator.mediaDevices.enumerateDevices();
      setOutputs(devices.filter((device) => device.kind === "audiooutput"));
    } catch (captureError) {
      await recorders.current.remote.stop(); await recorders.current.local.stop();
      setError(captureError instanceof Error ? captureError.message : "会議タブまたはマイクを取得できませんでした。");
      setStatus("error"); return;
    }

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socketRef.current = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: "session.start", options: { localLanguage, remoteLanguage }, accessToken }));
    socket.onmessage = (event) => handleMessage(JSON.parse(event.data) as ServerMessage);
    socket.onerror = () => { setError("翻訳サーバーへ接続できません。"); setStatus("error"); };
    socket.onclose = () => { readyRef.current = false; setStatus((value) => value === "error" ? value : "idle"); };
  };

  const stop = async () => {
    setStatus("stopping"); readyRef.current = false;
    await Promise.all([recorders.current.remote.stop(), recorders.current.local.stop()]);
    players.current.remote.close(); players.current.local.close();
    setLevels({ remote: 0, local: 0 });
    socketRef.current?.send(JSON.stringify({ type: "session.stop" }));
    setTimeout(() => socketRef.current?.close(), 1_000);
  };

  const lane = (channel: AudioChannel, title: string) => {
    const laneResults = results.filter((result) => result.channel === channel);
    const source = channel === "remote" ? remoteLanguage : localLanguage;
    const target = channel === "remote" ? localLanguage : remoteLanguage;
    return <section className="transcript-card lane">
      <div className="section-heading"><div><h2>{title}</h2><p>{languageNames[source]} → {languageNames[target]}</p></div></div>
      {partial[channel] && <article className="live-turn"><small>認識・翻訳中</small><p>{partial[channel]}</p></article>}
      {!partial[channel] && !laneResults.length && <div className="empty"><p>まだ発話はありません</p></div>}
      <div className="results">{laneResults.map((result) => <article key={result.id}>
        <div className="utterance original"><small>原文・{languageNames[source]}</small><p>{result.original}</p></div>
        <div className="utterance translation"><small>翻訳・{languageNames[target]}</small><p>{result.translation}</p></div>
      </article>)}</div>
    </section>;
  };

  return <main>
    <header className="hero"><div className="brand-mark">訳</div><div><p className="eyebrow">BIDIRECTIONAL LIVE INTERPRETER</p><h1>リアルタイム会議通訳</h1><p className="subtitle">会議タブとマイクを双方向に翻訳します</p></div><div className={`status status-${status}`}><span />{status === "listening" ? "翻訳中" : status === "connecting" ? "接続中" : "待機中"}</div></header>
    <section className="control-card">
      {authRequired && <label className="output-picker">アクセスキー
        <input type="password" autoComplete="current-password" value={accessToken} disabled={busy} onChange={(event) => setAccessToken(event.target.value)} placeholder="管理者から共有されたキー" />
        <small>OpenAI APIキーではありません。このサービス専用のアクセスキーです。</small>
      </label>}
      <div className="language-row">
        <label>自分の言語<select disabled={busy} value={localLanguage} onChange={(e) => setLocalLanguage(e.target.value as LanguageCode)}>{Object.entries(languageNames).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
        <button className="swap" disabled={busy} onClick={() => { setLocalLanguage(remoteLanguage); setRemoteLanguage(localLanguage); }}>⇄</button>
        <label>相手の言語<select disabled={busy} value={remoteLanguage} onChange={(e) => setRemoteLanguage(e.target.value as LanguageCode)}>{Object.entries(languageNames).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
      </div>
      <label className="output-picker">相手へ送る翻訳音声の出力先
        <select value={outgoingSinkId} onChange={(e) => setOutgoingSinkId(e.target.value)}><option value="">既定のスピーカー（動作確認用）</option>{outputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `音声出力 ${device.deviceId.slice(0, 6)}`}</option>)}</select>
        <small>本番では仮想オーディオケーブルの入力側を選び、Zoom/Meetのマイクにその出力側を指定します。</small>
      </label>
      <button className={`record ${status === "listening" ? "recording" : ""}`} disabled={status === "connecting" || status === "stopping"} onClick={status === "listening" ? stop : start}><span className="record-icon" />{status === "listening" ? "双方向翻訳を停止" : "会議タブを選んで開始"}</button>
      <div className="dual-meters"><span>相手 {Math.round(levels.remote * 100)}%</span><span>自分 {Math.round(levels.local * 100)}%</span></div>
      <p className="mock-note">開始時はZoom/Meetのタブを選び、「タブの音声を共有」をオンにしてください。ヘッドホン推奨です。</p>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
    <section className="workspace two-lanes">{lane("remote", "相手の発話 → 自分へ")}{lane("local", "自分の発話 → 相手へ")}</section>
    <aside className="metrics-card"><p className="eyebrow">SESSION METRICS</p><dl><div><dt>送信した発話</dt><dd>{metrics.audioSeconds.toFixed(1)}<small>秒</small></dd></div><div><dt>推定料金</dt><dd>${metrics.estimatedUsd.toFixed(4)}</dd></div></dl><p className="model-label">節約構成</p><code>gpt-transcribe + gpt-4o-mini + gpt-4o-mini-tts</code></aside>
  </main>;
}
