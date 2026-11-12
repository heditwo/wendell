const KERNEL_ZEROS = 16;

function blackman(position: number): number {
  return 0.42 + 0.5 * Math.cos(Math.PI * position) + 0.08 * Math.cos(2 * Math.PI * position);
}

function sinc(x: number): number {
  if (x === 0) return 1;

  const angle = Math.PI * x;

  return Math.sin(angle) / angle;
}

function concat(first: Float32Array, second: Float32Array): Float32Array {
  const joined = new Float32Array(first.length + second.length);

  joined.set(first, 0);
  joined.set(second, first.length);

  return joined;
}

/** Streaming windowed-sinc resampler for mono float samples. */
export class Resampler {
  readonly #step: number;
  readonly #cutoff: number;
  readonly #half: number;
  #pending: Float32Array;
  #position: number;
  #inputCount = 0;
  #outputCount = 0;
  readonly #outputRate: number;
  readonly #inputRate: number;

  constructor(inputRate: number, outputRate: number) {
    this.#inputRate = inputRate;
    this.#outputRate = outputRate;
    this.#step = inputRate / outputRate;
    this.#cutoff = Math.min(1, outputRate / inputRate);
    this.#half = Math.ceil(KERNEL_ZEROS / this.#cutoff);
    this.#pending = new Float32Array(this.#half);
    this.#position = this.#half;
  }

  process(input: Float32Array): Float32Array {
    this.#inputCount += input.length;

    return this.#run(input);
  }

  flush(): Float32Array {
    const expected = Math.round((this.#inputCount * this.#outputRate) / this.#inputRate);
    const tail = this.#run(new Float32Array(this.#half + Math.ceil(this.#step) + 1));
    const missing = Math.max(0, expected - this.#outputCount + tail.length);

    return tail.subarray(0, Math.min(tail.length, missing));
  }

  #run(input: Float32Array): Float32Array {
    const buffer = concat(this.#pending, input);
    const half = this.#half;
    const cutoff = this.#cutoff;
    const capacity = Math.max(0, Math.ceil((buffer.length - this.#position) / this.#step) + 1);
    const output = new Float32Array(capacity);
    let count = 0;
    let position = this.#position;

    while (Math.floor(position) + half < buffer.length) {
      const center = Math.floor(position);
      let sum = 0;

      for (let index = center - half + 1; index <= center + half; index++) {
        const distance = position - index;

        sum += (buffer[index] ?? 0) * cutoff * sinc(cutoff * distance) * blackman(distance / half);
      }

      output[count] = sum;
      count++;
      position += this.#step;
    }

    const keepFrom = Math.max(0, Math.floor(position) - half);

    this.#pending = buffer.slice(keepFrom);
    this.#position = position - keepFrom;
    this.#outputCount += count;

    return output.subarray(0, count);
  }
}

export function resample(samples: Float32Array, inputRate: number, outputRate: number): Float32Array {
  const resampler = new Resampler(inputRate, outputRate);

  return concat(resampler.process(samples), resampler.flush());
}

export function monoFromS16(bytes: Buffer): Float32Array {
  const samples = new Float32Array(Math.floor(bytes.length / 2));

  for (let index = 0; index < samples.length; index++) samples[index] = bytes.readInt16LE(index * 2) / 32768;

  return samples;
}

export function monoFromStereoS16(bytes: Buffer): Float32Array {
  const samples = new Float32Array(Math.floor(bytes.length / 4));

  for (let index = 0; index < samples.length; index++) {
    samples[index] = (bytes.readInt16LE(index * 4) + bytes.readInt16LE(index * 4 + 2)) / 65536;
  }

  return samples;
}

function clampS16(sample: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(sample * 32768)));
}

export function s16FromMono(samples: Float32Array): Buffer {
  const bytes = Buffer.alloc(samples.length * 2);

  for (let index = 0; index < samples.length; index++) bytes.writeInt16LE(clampS16(samples[index] ?? 0), index * 2);

  return bytes;
}

export function stereoS16FromMono(samples: Float32Array): Buffer {
  const bytes = Buffer.alloc(samples.length * 4);

  for (let index = 0; index < samples.length; index++) {
    const sample = clampS16(samples[index] ?? 0);

    bytes.writeInt16LE(sample, index * 4);
    bytes.writeInt16LE(sample, index * 4 + 2);
  }

  return bytes;
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;

  let sum = 0;

  for (const sample of samples) sum += sample * sample;

  return Math.sqrt(sum / samples.length);
}

export function joinSamples(chunks: readonly Float32Array[], length: number): Float32Array {
  const joined = new Float32Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    if (offset >= length) break;

    const part = chunk.subarray(0, length - offset);

    joined.set(part, offset);
    offset += part.length;
  }

  return joined;
}

export function wavFromS16(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
