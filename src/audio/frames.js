/**
 * PCM16LE モノラル音声のフレーム操作。
 *
 * Vonage と GPT-Live を同じサンプリングレートで揃えているためリサンプリングは不要。
 * ただし Vonage は 20ms 単位 (16kHz なら 640 バイト) での送受信を前提にしているので、
 * 可変長で届く GPT-Live の音声はフレームに切り直してから渡す。
 */

/** 20ms フレームのバイト数 (16bit モノラル) */
export const frameBytes = (rate) => (rate / 1000) * 20 * 2;

/** 1 フレームぶんの再生時間 (ms) */
export const FRAME_MS = 20;

/**
 * 可変長で届くバイト列を固定サイズのフレームに切り出す。
 * 端数は次回の呼び出しまで保持するため、音声が欠けない。
 */
export class FrameSplitter {
  #frameSize;
  #residual = Buffer.alloc(0);

  constructor(frameSize) {
    this.#frameSize = frameSize;
  }

  /**
   * @param {Buffer} chunk
   * @returns {Buffer[]} 切り出せた完全なフレームの配列
   */
  push(chunk) {
    const buffer = this.#residual.length ? Buffer.concat([this.#residual, chunk]) : chunk;
    const frameCount = Math.floor(buffer.length / this.#frameSize);
    const frames = [];

    for (let i = 0; i < frameCount; i++) {
      frames.push(buffer.subarray(i * this.#frameSize, (i + 1) * this.#frameSize));
    }

    // subarray は元バッファへの参照を持つため、端数はコピーして保持する
    this.#residual = Buffer.from(buffer.subarray(frameCount * this.#frameSize));
    return frames;
  }

  /**
   * 保持している端数を無音で埋めて 1 フレームとして取り出す。
   * 発話の最後がフレーム境界で終わらないときに末尾が欠けるのを防ぐ。
   * @returns {Buffer | null} 端数が無ければ null
   */
  flush() {
    if (this.#residual.length === 0) return null;

    const frame = Buffer.alloc(this.#frameSize);
    this.#residual.copy(frame);
    this.#residual = Buffer.alloc(0);
    return frame;
  }

  /** 保持している端数を破棄する */
  reset() {
    this.#residual = Buffer.alloc(0);
  }
}
