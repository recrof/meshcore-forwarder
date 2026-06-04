import { SerialPort } from 'serialport';
import { EventEmitter } from 'node:events';

const FEND = 0xC0;
const FESC = 0xDB;
const TFEND = 0xDC;
const TFESC = 0xDD;

const CMD_DATA = 0x00;
const CMD_SET_HARDWARE = 0x06;

const HW_CMD_SET_RADIO = 0x09;
const HW_CMD_SET_TX_POWER = 0x0A;
const HW_CMD_SET_SIGNAL_REPORT = 0x19;
const HW_RESP_RADIO = 0x8B;
const HW_RESP_TX_POWER = 0x8C;
const HW_RESP_OK = 0xF0;
const HW_RESP_ERROR = 0xF1;
const HW_RESP_TX_DONE = 0xF8;
const HW_RESP_RX_META = 0xF9;

function escape(bytes) {
  const out = [];
  for (const b of bytes) {
    if (b === FEND) { out.push(FESC, TFEND); }
    else if (b === FESC) { out.push(FESC, TFESC); }
    else { out.push(b); }
  }
  return Buffer.from(out);
}

function frame(type, data) {
  const body = escape(Buffer.concat([Buffer.from([type]), data]));
  return Buffer.concat([Buffer.from([FEND]), body, Buffer.from([FEND])]);
}

// Decodes a stream of KISS bytes, yielding {type, data} per frame.
class KissDecoder {
  constructor() {
    this.buf = [];
    this.escaping = false;
    this.inFrame = false;
  }
  *push(chunk) {
    for (const b of chunk) {
      if (b === FEND) {
        if (this.inFrame && this.buf.length > 0) {
          const type = this.buf[0];
          const data = Buffer.from(this.buf.slice(1));
          yield { type, data };
        }
        this.buf = [];
        this.escaping = false;
        this.inFrame = true;
        continue;
      }
      if (!this.inFrame) continue;
      if (this.escaping) {
        if (b === TFEND) this.buf.push(FEND);
        else if (b === TFESC) this.buf.push(FESC);
        else this.buf.push(b);
        this.escaping = false;
      } else if (b === FESC) {
        this.escaping = true;
      } else {
        this.buf.push(b);
      }
    }
  }
}

export class KissPort extends EventEmitter {
  constructor({ path, baudRate = 115200 }) {
    super();
    this.path = path;
    this.baudRate = baudRate;
    this.port = null;
    this.decoder = new KissDecoder();
    this._hwWaiters = []; // {match, resolve, reject, timer}
  }

  open() {
    return new Promise((resolve, reject) => {
      this.port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false });
      this.port.on('data', (chunk) => this._onChunk(chunk));
      this.port.on('error', (err) => this.emit('error', err));
      this.port.on('close', () => this.emit('close'));
      this.port.open((err) => err ? reject(err) : resolve());
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.port || !this.port.isOpen) return resolve();
      this.port.close(() => resolve());
    });
  }

  _onChunk(chunk) {
    try {
      for (const { type, data } of this.decoder.push(chunk)) {
        try { this._dispatch(type, data); } catch (err) { this.emit('error', err); }
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  // KISS Data frame payload limit per modem firmware
  static MAX_TX_LEN = 255;

  _dispatch(type, data) {
    if (type === CMD_DATA) {
      this.emit('packet', data);
      return;
    }
    if (type === CMD_SET_HARDWARE) {
      if (data.length === 0) return;
      const sub = data[0];
      const body = data.subarray(1);
      if (sub === HW_RESP_RX_META) {
        // SNR (signed, *4), RSSI (signed)
        const snr = body.length >= 1 ? (body.readInt8(0) / 4) : null;
        const rssi = body.length >= 2 ? body.readInt8(1) : null;
        this.emit('rxMeta', { snr, rssi });
        return;
      }
      if (sub === HW_RESP_TX_DONE) {
        const ok = body.length >= 1 ? body[0] === 1 : false;
        this.emit('txDone', ok);
        return;
      }
      if (sub === HW_RESP_ERROR) {
        const code = body.length >= 1 ? body[0] : null;
        // Errors that surface during async TX (no matching waiter) — emit for the radio loop.
        this.emit('hwError', code);
      }
      // wake any waiters for this sub
      for (let i = this._hwWaiters.length - 1; i >= 0; i--) {
        const w = this._hwWaiters[i];
        if (w.match(sub, body)) {
          this._hwWaiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve({ sub, body });
        }
      }
    }
  }

  _waitHw(matchFn, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const w = { match: matchFn, resolve, reject };
      w.timer = setTimeout(() => {
        const idx = this._hwWaiters.indexOf(w);
        if (idx >= 0) this._hwWaiters.splice(idx, 1);
        reject(new Error('hw response timeout'));
      }, timeoutMs);
      this._hwWaiters.push(w);
    });
  }

  _writeFrame(type, data) {
    return new Promise((resolve, reject) => {
      this.port.write(frame(type, data), (err) => err ? reject(err) : resolve());
    });
  }

  sendPacket(bytes) {
    return this._writeFrame(CMD_DATA, Buffer.from(bytes));
  }

  async setRadio({ freq, bw, sf, cr }) {
    // freq Hz uint32, bw Hz uint32, sf u8, cr u8 — little-endian
    const buf = Buffer.alloc(10);
    buf.writeUInt32LE(Math.round(freq), 0);
    buf.writeUInt32LE(Math.round(bw), 4);
    buf.writeUInt8(sf, 8);
    buf.writeUInt8(cr, 9);
    const payload = Buffer.concat([Buffer.from([HW_CMD_SET_RADIO]), buf]);
    await this._writeFrame(CMD_SET_HARDWARE, payload);
    await this._waitHw((sub) => sub === HW_RESP_RADIO || sub === HW_RESP_OK || sub === HW_RESP_ERROR, 3000);
  }

  async setTxPower(dBm) {
    const buf = Buffer.alloc(1);
    buf.writeInt8(dBm, 0);
    const payload = Buffer.concat([Buffer.from([HW_CMD_SET_TX_POWER]), buf]);
    await this._writeFrame(CMD_SET_HARDWARE, payload);
    await this._waitHw((sub) => sub === HW_RESP_TX_POWER || sub === HW_RESP_OK || sub === HW_RESP_ERROR, 2000);
  }

  async setSignalReport(enabled) {
    const payload = Buffer.from([HW_CMD_SET_SIGNAL_REPORT, enabled ? 1 : 0]);
    await this._writeFrame(CMD_SET_HARDWARE, payload);
    await this._waitHw((sub) => sub === HW_RESP_OK || sub === HW_RESP_ERROR, 1000).catch(() => {});
  }
}
