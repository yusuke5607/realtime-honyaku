export class PcmRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  async start(onChunk: (base64: string) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.context = new AudioContext({ sampleRate: 24_000 });
    await this.context.resume();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      const bytes = new Uint8Array(pcm.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      onChunk(btoa(binary));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.context.destination);
  }

  async stop(): Promise<void> {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close();
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.context = null;
  }
}

export class PcmPlayer {
  private context: AudioContext | null = null;
  private playAt = 0;

  async append(base64: string): Promise<void> {
    this.context ??= new AudioContext({ sampleRate: 24_000 });
    await this.context.resume();
    const binary = atob(base64);
    const pcm = new Int16Array(binary.length / 2);
    for (let i = 0; i < pcm.length; i += 1) {
      pcm[i] = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    }
    const buffer = this.context.createBuffer(1, pcm.length, 24_000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 0x8000;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.playAt = Math.max(this.playAt, this.context.currentTime);
    source.start(this.playAt);
    this.playAt += buffer.duration;
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.playAt = 0;
  }
}
