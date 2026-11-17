#!/usr/bin/env node
import { config } from './config.mjs';
import { Radio } from './lib/radio.mjs';
import { wrap, Constants, formatGrpTxt, resolveChannels } from './lib/packet-wrap.mjs';
import { Dedup } from './lib/dedup.mjs';
import { MqttObserver } from './lib/observer.mjs';
import { makeLogger, configureLogging, isDebug } from './lib/log.mjs';

configureLogging({ timestamps: config.logTimestamps, debug: config.debug });

const log = makeLogger('forwarder');
const dedup = new Dedup();
const debugChannels = resolveChannels(config.debugChannels);

function handleRx(sourceRadio, radios, raw, meta) {
  let packet;
  try {
    packet = wrap(raw);
  } catch (err) {
    log.warn(`${sourceRadio.name}: parse error: ${err.message}`);
    return;
  }

  if (packet.is_marked_do_not_retransmit) return;

  if (dedup.seen(packet)) return;

  if (isDebug() && packet.type === Constants.GRP_TXT) {
    const signal = meta ? ` snr=${meta.snr} rssi=${meta.rssi}` : '';
    log.debug(`${sourceRadio.name}:${signal} ${formatGrpTxt(packet, debugChannels)}`);
  }

  let pass = true;
  if (typeof config.filter === 'function') {
    try {
      pass = !!config.filter(packet, Constants);
    } catch (err) {
      log.warn(`filter threw: ${err.message}`);
      pass = false;
    }
  }
  if (!pass) return;

  log.info(`${sourceRadio.name} -> fwd ${packet.typeName} (${packet.raw.length}B)`);
  for (const r of radios) {
    if (r === sourceRadio) continue;
    r.enqueue(packet.raw);
  }
}

async function main() {
  if (!Array.isArray(config.radios) || config.radios.length < 2) {
    log.error('config.radios must contain at least 2 entries');
    process.exit(1);
  }

  const radios = config.radios.map((cfg) => new Radio(cfg, makeLogger(cfg.name), { statsInterval: config.statsInterval }));

  try {
    await Promise.all(radios.map((r) => r.start()));
  } catch (err) {
    log.error(err.message);
    process.exit(2);
  }

  for (const r of radios) {
    r.on('rx', (raw, meta) => handleRx(r, radios, raw, meta));
  }

  // per-radio MQTT reporting: radio.mqtt is one broker config or an array of them
  const observers = [];
  for (const r of radios) {
    for (const mqttCfg of [r.cfg.mqtt ?? []].flat()) {
      const obs = new MqttObserver(r, mqttCfg, makeLogger(`${r.name}/mqtt`));
      obs.start().catch((err) => log.warn(`${r.name}: mqtt observer failed to start: ${err.message}`));
      observers.push(obs);
    }
  }

  log.info(`up with ${radios.length} radios`);

  const shutdown = async (sig) => {
    log.info(`${sig} received, shutting down`);
    await Promise.allSettled(observers.map((o) => o.stop()));
    await Promise.allSettled(radios.map((r) => r.stop()));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
