export type RecorderSource = "microphone" | "meeting-tab";

export class PcmRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;

  async start(
    sourceType: RecorderSource,
    onChunk: (base64: string, speechActive: boolean) => void,
    onLevel?: (level: number) => void,
    onSpeechEnd?: () => void,
  ): Promise<void> {
    this.stream = sourceType === "microphone"
      ? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (!this.stream.getAudioTracks().length) {
      this.stream.getTracks().forEach((track) => track.stop());
      throw new Error("選択した画面に音声が含まれていません。「タブの音声を共有」を有効にしてください。");
    }

    this.context = new AudioContext({ sampleRate: 24_000 });
    await this.context.resume();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    let speaking = false;
    let silenceMs = 0;
    const preRoll: string[] = [];
    this.processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(samples.length);
      let sumSquares = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, samples[i]));
        sumSquares += sample * sample;
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      const rms = Math.sqrt(sumSquares / samples.length);
      onLevel?.(Math.min(1, rms * 8));
      const speechStarted = !speaking && rms >= 0.018;
      if (rms >= 0.018) { speaking = true; silenceMs = 0; }
      else if (speaking) {
        silenceMs += (samples.length / this.context!.sampleRate) * 1_000;
        if (silenceMs >= 1_300) { speaking = false; silenceMs = 0; onSpeechEnd?.(); }
      }
      const bytes = new Uint8Array(pcm.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const encoded = btoa(binary);
      if (speechStarted) {
        for (const buffered of preRoll) onChunk(buffered, true);
        preRoll.length = 0;
      }
      onChunk(encoded, speaking);
      if (!speaking) {
        preRoll.push(encoded);
        if (preRoll.length > 3) preRoll.shift();
      }
    };
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  async stop(): Promise<void> {
    this.processor?.disconnect(); this.source?.disconnect(); this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close();
    this.processor = null; this.source = null; this.sink = null; this.stream = null; this.context = null;
  }
}

export class AudioFilePlayer {
  private queue: Array<{ audio: string; mimeType: string }> = [];
  private playing = false;
  private sinkId = "";
  private current: HTMLAudioElement | null = null;

  setSinkId(sinkId: string): void { this.sinkId = sinkId; }

  append(audio: string, mimeType: string): void {
    this.queue.push({ audio, mimeType });
    if (!this.playing) void this.playNext();
  }

  close(): void {
    this.queue = [];
    this.current?.pause();
    this.current = null;
    this.playing = false;
  }

  private async playNext(): Promise<void> {
    const item = this.queue.shift();
    if (!item) { this.playing = false; return; }
    this.playing = true;
    const binary = atob(item.audio);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: item.mimeType }));
    const element = new Audio(url);
    this.current = element;
    try {
      if (this.sinkId && "setSinkId" in element) await element.setSinkId(this.sinkId);
      await element.play();
      await new Promise<void>((resolve) => { element.onended = () => resolve(); element.onerror = () => resolve(); });
    } finally {
      URL.revokeObjectURL(url);
      if (this.current === element) this.current = null;
      void this.playNext();
    }
  }
}
