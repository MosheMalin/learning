// Validation of an incoming batch. Everything the client sends is data from a
// browser anyone can open: check shape, size and range, keep the rest verbatim.
// A bad event is reported with its index, so the client can drop just that one.

import { EVENT_TYPES, RESULTS } from './fold.js';

export const MAX_EVENTS = 200;
export const MAX_EVENT_BYTES = 16 * 1024;
export const MAX_START_BYTES = 64 * 1024;   // session.started carries the unit's items
export const MAX_ITEMS = 400;               // items per unit snapshot
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_TRY = 100;
export const MAX_NUMBER = 1e7;              // scores, latencies: nothing sane is bigger

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const APP_RE = /^[a-z0-9-]{1,40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEVICE_KEYS = ['tz', 'lang', 'ua', 'screen'];

const isIso = v => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
const numOk = v => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_NUMBER);

/* Only the few short strings the dashboard has a use for. */
function cleanDevice(d) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  for (const k of DEVICE_KEYS) if (typeof d[k] === 'string') out[k] = d[k].slice(0, 200);
  return out;
}

/* Returns { ok: true, app, appVersion, device, events } or { ok: false, error, index? }. */
export function validateBatch(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'expected an object' };
  if (body.schema !== 1) return { ok: false, error: 'unknown schema' };
  if (!APP_RE.test(String(body.app || ''))) return { ok: false, error: 'bad app' };
  if (!Array.isArray(body.events)) return { ok: false, error: 'events must be an array' };
  if (body.events.length > MAX_EVENTS) return { ok: false, error: `at most ${MAX_EVENTS} events` };

  const events = [];
  for (let index = 0; index < body.events.length; index++) {
    const ev = body.events[index];
    const bad = error => ({ ok: false, error, index });
    if (!ev || typeof ev !== 'object') return bad('bad event');
    if (!ID_RE.test(String(ev.id || ''))) return bad('bad event id');
    if (!EVENT_TYPES.has(ev.type)) return bad(`unknown event type ${ev.type}`);
    if (!ID_RE.test(String(ev.session || ''))) return bad('bad session id');
    if (!isIso(ev.at)) return bad('bad timestamp');
    if (ev.type.startsWith('item.')) {
      if (!Number.isInteger(ev.seq) || ev.seq < 1 || ev.seq > 10000) return bad('bad seq');
    }
    if (ev.type === 'item.answered') {
      if (!RESULTS.has(ev.result)) return bad('bad result');
      if (!Number.isInteger(ev.try) || ev.try < 1 || ev.try > MAX_TRY) return bad('bad try');
      if (!numOk(ev.score) || !numOk(ev.maxScore) || !numOk(ev.latencyMs)) return bad('bad number');
    }
    if (ev.type === 'session.started') {
      if (ev.localDate !== undefined && !(typeof ev.localDate === 'string' && DAY_RE.test(ev.localDate))) return bad('bad localDate');
      if (ev.unit && Array.isArray(ev.unit.items) && ev.unit.items.length > MAX_ITEMS) return bad('too many items');
      if (ev.params && !numOk(ev.params.itemCount)) return bad('bad number');
    }
    if (ev.type === 'session.completed') {
      for (const k of ['score', 'maxScore', 'itemCount', 'correctFirstTry', 'correctEventually']) {
        if (!numOk(ev[k])) return bad('bad number');
      }
    }
    const cap = ev.type === 'session.started' ? MAX_START_BYTES : MAX_EVENT_BYTES;
    if (JSON.stringify(ev).length > cap) return bad('event too large');
    events.push(ev);
  }
  return {
    ok: true,
    app: body.app,
    appVersion: body.appVersion == null ? null : String(body.appVersion).slice(0, 40),
    device: cleanDevice(body.device),
    events,
  };
}
