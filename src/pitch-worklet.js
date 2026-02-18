// AudioWorklet processor for pitch shifting via SoundTouch.
// SoundTouch source is prepended by renderer.js before addModule(), so the
// SoundTouch class is available in this global scope.
//
// SoundTouch runs in pitch-only mode (st.tempo always 1.0).
// Tempo is handled externally by audioElement.playbackRate so that the frame
// rate into the worklet always equals the frame rate out — preventing ring
// buffer overflow at non-default tempos.

const RING = 65536; // Output ring-buffer frames (~1.5 s at 44100 Hz)

class PitchTempoProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._stPitch = 1.0;
        this._st      = this._newST();

        // Pre-allocated scratch buffers (avoids per-callback GC pressure)
        this._interleaved = new Float32Array(256); // 128 frames × 2 ch
        this._drainBuf    = new Float32Array(1024);

        // Output ring buffer
        this._ringL  = new Float32Array(RING);
        this._ringR  = new Float32Array(RING);
        this._ringW  = 0; // write pointer
        this._ringRd = 0; // read pointer

        // Messages from main thread:
        //   { stPitch: number } — pre-computed SoundTouch pitch multiplier
        //   { flush: true }     — clear state after a seek
        this.port.onmessage = ({ data }) => {
            if (data.stPitch !== undefined) {
                this._stPitch  = data.stPitch;
                this._st.pitch = this._stPitch;
            }
            if (data.flush) {
                this._st     = this._newST();
                this._ringW  = 0;
                this._ringRd = 0;
            }
        };
    }

    _newST() {
        const st = new SoundTouch();
        st.tempo = 1.0; // Never time-stretch inside the worklet
        st.pitch = this._stPitch ?? 1.0;
        return st;
    }

    _ringAvail() {
        return (this._ringW - this._ringRd + RING) % RING;
    }

    // Drain all available output from SoundTouch into the ring buffer
    _drainST() {
        let n = this._st.outputBuffer.frameCount;
        while (n > 0) {
            const take = Math.min(n, 512);
            if (this._drainBuf.length < take * 2) {
                this._drainBuf = new Float32Array(take * 2);
            }
            this._st.outputBuffer.receiveSamples(this._drainBuf, take);
            for (let i = 0; i < take; i++) {
                this._ringL[this._ringW] = this._drainBuf[i * 2];
                this._ringR[this._ringW] = this._drainBuf[i * 2 + 1];
                this._ringW = (this._ringW + 1) % RING;
            }
            n = this._st.outputBuffer.frameCount;
        }
    }

    process(inputs, outputs) {
        const inL  = inputs[0]?.[0];
        const inR  = inputs[0]?.[1] ?? inL;
        const outL = outputs[0]?.[0];

        if (!inL || !outL) return true;

        const N = inL.length; // 128 in Chromium/Electron

        // Feed this block into SoundTouch
        if (this._interleaved.length < N * 2) {
            this._interleaved = new Float32Array(N * 2);
        }
        for (let i = 0; i < N; i++) {
            this._interleaved[i * 2]     = inL[i];
            this._interleaved[i * 2 + 1] = inR[i];
        }
        this._st.inputBuffer.putSamples(this._interleaved, 0, N);
        this._st.process();
        this._drainST();

        // Output from ring buffer; pass through if not filled yet
        // (handles initial SoundTouch latency and post-seek gap)
        if (this._ringAvail() >= N) {
            const outR = outputs[0]?.[1] ?? outL;
            for (let i = 0; i < N; i++) {
                outL[i] = this._ringL[this._ringRd];
                outR[i] = this._ringR[this._ringRd];
                this._ringRd = (this._ringRd + 1) % RING;
            }
        } else {
            outL.set(inL);
            if (outputs[0][1]) outputs[0][1].set(inR);
        }

        return true;
    }
}

registerProcessor('pitch-tempo-processor', PitchTempoProcessor);
