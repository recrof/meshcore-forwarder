// MQTT observer: reports every packet a radio hears (with SNR/RSSI) in the
// meshcoretomqtt JSON format, ported from ZephCore's ObserverMesh / MeshcoreJson.h.
//
// Topics: meshcore/<IATA>/<PUBKEY>/packets  — one message per reception (no dedup)
//         meshcore/<IATA>/<PUBKEY>/status   — retained online/offline + stats
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { Packet } from '@liamcottle/meshcore.js';

const STATUS_INTERVAL_MS = 300_000;
const MAX_HASH_SIZE = 8;
const OFFLINE_JSON = '{"status":"offline"}';

const { version: CLIENT_VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const hexUpper = (bytes) => Buffer.from(bytes).toString('hex').toUpperCase();

// ZephCore timestamps: UTC, "YYYY-MM-DDTHH:MM:SS.ffffff"
function timestamps(date = new Date()) {
  const iso = date.toISOString();
  return {
    timestamp: `${iso.slice(0, 23)}000`,
    time: iso.slice(11, 19),
    date: `${date.getUTCDate()}/${date.getUTCMonth() + 1}/${date.getUTCFullYear()}`,
  };
}

// Matches firmware Packet::calculatePacketHash: sha256(type [, path_len] || payload)[0:8]
function packetHash(pkt) {
  const h = createHash('sha256');
  h.update(Buffer.from([pkt.type]));
  if (pkt.type === Packet.PAYLOAD_TYPE_TRACE) h.update(Buffer.from([pkt.pathLen ?? 0]));
  h.update(pkt.payload);
  return hexUpper(h.digest().subarray(0, MAX_HASH_SIZE));
}

// Matches firmware RadioLibWrapper::packetScoreInt (0..1)
const SNR_THRESHOLD = [-7.5, -10, -12.5, -15, -17.5, -20];
function packetScore(snr, sf, len) {
  if (sf < 7 || sf > 12) return 0;
  const threshold = SNR_THRESHOLD[sf - 7];
  if (snr < threshold) return 0;
  return Math.max(0, Math.min(1, ((snr - threshold) / 10) * (1 - len / 256)));
}

export class MqttObserver {
  // cfg: { url, username, password, iata, name, rejectUnauthorized }
  constructor(radio, cfg, log) {
    this.radio = radio;
    this.cfg = cfg;
    this.log = log;
    this.client = null;
    this._statusTimer = null;
    this._startedAt = Date.now();
  }

  start() {
    const { radio, cfg } = this;
    if (!radio.publicKey) {
      this.log.warn('modem identity unavailable, MQTT observer disabled');
      return;
    }
    this.originId = hexUpper(radio.publicKey);
    this.origin = cfg.name ?? radio.name;
    const base = `meshcore/${cfg.iata ?? 'XXX'}/${this.originId}`;
    this.packetsTopic = `${base}/packets`;
    this.statusTopic = `${base}/status`;

    this.client = mqtt.connect(cfg.url, {
      clientId: `mcfwd_${this.originId.slice(0, 16)}`,
      username: cfg.username,
      password: cfg.password,
      rejectUnauthorized: cfg.rejectUnauthorized ?? true,
      keepalive: 60,
      reconnectPeriod: 5_000,
      // drop reports while disconnected instead of flushing stale ones on reconnect
      queueQoSZero: false,
      will: { topic: this.statusTopic, payload: OFFLINE_JSON, qos: 0, retain: true },
    });
    this.client.on('connect', () => {
      this.log.info(`mqtt connected ${cfg.url} topic=${base}`);
      this.publishStatus('online');
    });
    this.client.on('error', (err) => this.log.warn(`mqtt error: ${err.message}`));
    this.client.on('offline', () => this.log.warn('mqtt offline, reconnecting'));

    this._onRx = (raw, meta) => this.publishPacket(raw, meta);
    radio.on('rx', this._onRx);

    this._statusTimer = setInterval(() => this.publishStatus('online'), STATUS_INTERVAL_MS);
    this._statusTimer.unref?.();
  }

  publishPacket(raw, meta) {
    if (!this.client?.connected) return;
    let pkt;
    try {
      pkt = Packet.fromBytes(raw);
    } catch {
      return;
    }
    pkt.type = pkt.payload_type;
    const routeType = pkt.route_type;
    const direct = routeType === Packet.ROUTE_TYPE_DIRECT || routeType === Packet.ROUTE_TYPE_TRANSPORT_DIRECT;
    const { timestamp, time, date } = timestamps();

    // key order and string values match ZephCore; firmware logs SNR/RSSI as ints
    const json = {
      type: 'PACKET',
      origin: this.origin,
      origin_id: this.originId,
      timestamp,
      direction: 'rx',
      time,
      date,
      len: String(raw.length),
      packet_type: String(pkt.type),
      route: direct ? 'D' : 'F',
      payload_len: String(pkt.payload.length),
      raw: hexUpper(raw),
    };
    if (meta) {
      json.SNR = String(Math.trunc(meta.snr));
      json.RSSI = String(Math.trunc(meta.rssi));
      json.score = String(Math.trunc(packetScore(meta.snr, this.radio.cfg.sf, raw.length) * 1000));
    }
    json.hash = packetHash(pkt);

    this.client.publish(this.packetsTopic, JSON.stringify(json), { qos: 0 });
  }

  async publishStatus(status) {
    if (!this.client?.connected) return;
    const { radio } = this;
    const { cfg: rc } = radio;
    const kiss = radio.kiss;
    const query = (fn) => (kiss ? fn(kiss).catch(() => null) : Promise.resolve(null));
    const noiseFloor = await query((k) => k.getNoiseFloor());
    const modemStats = await query((k) => k.getStats());

    const json = {
      status,
      timestamp: timestamps().timestamp,
      origin: this.origin,
      origin_id: this.originId,
      radio: `${rc.freq.toFixed(3)},${rc.bw.toFixed(1)},${rc.sf},${rc.cr}`,
      model: radio.deviceName ?? 'unknown',
      firmware_version: `kiss v${radio.version ?? '?'}`,
      client_version: `meshcore-forwarder/${CLIENT_VERSION}`,
      // the forwarder never adds itself to packet paths, so it is not a path-hop candidate
      repeat: 'off',
      stats: {
        battery_mv: 0, // USB-powered modem
        uptime_secs: Math.floor((Date.now() - this._startedAt) / 1000),
        debug_flags: 0,
        queue_len: radio.queue.length,
        noise_floor: noiseFloor ?? 0,
        tx_air_secs: 0,
        rx_air_secs: 0,
        recv_errors: modemStats?.errors ?? 0,
      },
    };
    this.client.publish(this.statusTopic, JSON.stringify(json), { qos: 0, retain: true });
  }

  async stop() {
    if (this._statusTimer) clearInterval(this._statusTimer);
    if (this._onRx) this.radio.off('rx', this._onRx);
    if (!this.client) return;
    if (this.client.connected) {
      await new Promise((resolve) => {
        this.client.publish(this.statusTopic, OFFLINE_JSON, { qos: 0, retain: true }, () => resolve());
      });
    }
    await this.client.endAsync().catch(() => {});
  }
}
