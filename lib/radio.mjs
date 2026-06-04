import { EventEmitter } from 'node:events';
import { KissPort } from './kiss.mjs';

const TX_DONE_TIMEOUT_MS = 4_000;
const MAX_CONNECT_ATTEMPTS = 10;
const MAX_QUEUE = 32;
const MAX_TX_RETRIES = 3;
const TX_BUSY_BACKOFF_MS = 250;
const HEARTBEAT_MS = 30_000;

const ERR_TX_BUSY = 0x07;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Radio extends EventEmitter {
  constructor(cfg, log) {
    super();
    this.cfg = cfg;
    this.name = cfg.name;
    this.log = log;
    this.kiss = null;
    this.queue = [];
    this.busy = false;
    this.closed = false;
    this.txOk = 0;
    this.txFail = 0;
    this.txDropped = 0;
    this.rxCount = 0;
    this._heartbeat = null;
  }

  async start() {
    await this._connectWithRetry();
    this._wireEvents();
    this._heartbeat = setInterval(() => {
      this.log.info(`stats rx=${this.rxCount} tx_ok=${this.txOk} tx_fail=${this.txFail} dropped=${this.txDropped} queue=${this.queue.length}`);
    }, HEARTBEAT_MS);
    this._heartbeat.unref?.();
  }

  _wireEvents() {
    this.kiss.on('packet', (data) => { this.rxCount++; this.emit('rx', data); });
    this.kiss.on('error', (err) => this.log.warn(`serial error: ${err.message}`));
    this.kiss.on('close', () => {
      if (this.closed) return;
      this.log.warn('serial closed unexpectedly, reconnecting');
      this._reconnect();
    });
  }

  async _reconnect() {
    try {
      await this.kiss?.close().catch(() => {});
    } catch {}
    this.kiss = null;
    try {
      await this._connectWithRetry();
      this._wireEvents();
      this._drain();
    } catch (err) {
      this.log.error(`reconnect failed permanently: ${err.message}`);
      process.exit(2);
    }
  }

  async _connectWithRetry() {
    let delay = 500;
    for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
      try {
        const kiss = new KissPort({ path: this.cfg.port });
        await kiss.open();
        await kiss.setRadio({
          freq: this.cfg.freq * 1_000_000,
          bw: this.cfg.bw * 1000,
          sf: this.cfg.sf,
          cr: this.cfg.cr,
        });
        const txPower = this.cfg.txPower ?? 22;
        await kiss.setTxPower(txPower);
        await kiss.setSignalReport(false);
        this.kiss = kiss;
        this.log.info(`connected ${this.cfg.port} freq=${this.cfg.freq}MHz bw=${this.cfg.bw}kHz sf=${this.cfg.sf} cr=${this.cfg.cr} tx=${txPower}dBm`);
        return;
      } catch (err) {
        this.log.warn(`connect attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} failed: ${err.message}`);
        if (attempt === MAX_CONNECT_ATTEMPTS) {
          throw new Error(`radio ${this.name}: failed to connect after ${MAX_CONNECT_ATTEMPTS} attempts`);
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 15_000);
      }
    }
  }

  enqueue(bytes) {
    if (bytes.length > KissPort.MAX_TX_LEN) {
      this.txDropped++;
      this.log.warn(`drop oversized packet ${bytes.length}B (max ${KissPort.MAX_TX_LEN})`);
      return;
    }
    if (this.queue.length >= MAX_QUEUE) {
      const dropped = this.queue.shift();
      this.txDropped++;
      this.log.warn(`queue full (${MAX_QUEUE}), dropping oldest ${dropped.length}B packet`);
    }
    this.queue.push(bytes);
    this._drain();
  }

  // Wait for txDone OR an hwError (TxBusy) for the packet currently in flight.
  _waitTx() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.kiss.off('txDone', onDone);
        this.kiss.off('hwError', onErr);
        resolve(result);
      };
      const onDone = (ok) => finish(ok ? 'ok' : 'fail');
      const onErr = (code) => finish(code === ERR_TX_BUSY ? 'busy' : 'fail');
      const timer = setTimeout(() => finish('timeout'), TX_DONE_TIMEOUT_MS);
      this.kiss.on('txDone', onDone);
      this.kiss.on('hwError', onErr);
    });
  }

  async _drain() {
    if (this.busy || this.closed || !this.kiss) return;
    this.busy = true;
    try {
      while (this.queue.length > 0 && !this.closed && this.kiss) {
        const bytes = this.queue[0];
        let attempt = 0;
        let result = 'fail';
        while (attempt < MAX_TX_RETRIES && !this.closed && this.kiss) {
          attempt++;
          const waiter = this._waitTx();
          try {
            await this.kiss.sendPacket(bytes);
          } catch (err) {
            this.log.warn(`tx write error: ${err.message}`);
            result = 'fail';
            break;
          }
          result = await waiter;
          if (result === 'ok') break;
          if (result === 'busy') {
            this.log.warn(`tx busy, retry ${attempt}/${MAX_TX_RETRIES} after ${TX_BUSY_BACKOFF_MS}ms`);
            await sleep(TX_BUSY_BACKOFF_MS * attempt);
            continue;
          }
          // 'fail' or 'timeout' — give up on this packet
          this.log.warn(`tx ${result}, dropping`);
          break;
        }
        this.queue.shift();
        if (result === 'ok') this.txOk++; else this.txFail++;
      }
    } finally {
      this.busy = false;
    }
  }

  async stop() {
    this.closed = true;
    if (this._heartbeat) clearInterval(this._heartbeat);
    if (this.kiss) await this.kiss.close().catch(() => {});
  }
}
