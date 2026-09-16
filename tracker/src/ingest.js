// Validation of an incoming batch. Everything the client sends is data from a
// browser anyone can open: check shape and size, keep the rest verbatim.

import { EVENT_TYPES, RESULTS } from './fold.js';

export const MAX_EVENTS = 200;
export const MAX_EVENT_BYTES = 16 * 1024;
export const MAX_BODY_BYTES = 1024 * 1024;

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const APP_RE = /^[a-z0-9-]{1,40}$/;

const isIso = v => typeof v === 'string' && v.length >= 20 && v.length <= 40 && !Number.isNaN(Date.parse(v));

/* Returns { ok: true, app, appVersion, device, events } or { ok: false, error }. */
export function validateBatch(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'expected an object' };
  if (body.schema !== 1) return { ok: false, error: 'unknown schema' };
  if (!APP_RE.test(String(body.app || ''))) return { ok: false, error: 'bad app' };
  if (!Array.isArray(body.events)) return { ok: false, error: 'events must be an array' };
  if (body.events.length > MAX_EVENTS) return { ok: false, error: `at most ${MAX_EVENTS} events` };

  const events = [];
  for (const ev of body.events) {
    if (!ev || typeof ev !== 'object') return { ok: false, error: 'bad event' };
    if (!ID_RE.test(String(ev.id || ''))) return { ok: false, error: 'bad event id' };
    if (!EVENT_TYPES.has(ev.type)) return { ok: false, error: `unknown event type ${ev.type}` };
    if (!ID_RE.test(String(ev.session || ''))) return { ok: false, error: 'bad session id' };
    if (!isIso(ev.at)) return { ok: false, error: 'bad timestamp' };
    if (ev.type.startsWith('item.')) {
      if (!Number.isInteger(ev.seq) || ev.seq < 1 || ev.seq > 10000) return { ok: false, error: 'bad seq' };
    }
    if (ev.type === 'item.answered' && !RESULTS.has(ev.result)) return { ok: false, error: 'bad result' };
    if (JSON.stringify(ev).length > MAX_EVENT_BYTES) return { ok: false, error: 'event too large' };
    events.push(ev);
  }
  return {
    ok: true,
    app: body.app,
    appVersion: body.appVersion == null ? null : String(body.appVersion).slice(0, 40),
    device: body.device && typeof body.device === 'object' ? body.device : null,
    events,
  };
}
