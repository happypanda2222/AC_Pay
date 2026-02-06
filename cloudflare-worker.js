const CALENDAR_KEY = 'calendar:default';
const CALENDAR_SCHEMA_VERSION = 3;
const CALENDAR_GATE_SYNC_LOOKBACK_MS = 30 * 60 * 60 * 1000;
const CALENDAR_GATE_SYNC_RETRY_DELAY_MS = 12 * 60 * 60 * 1000;
const CALENDAR_GATE_SYNC_MAX_ATTEMPTS = 2;
const CALENDAR_AIRLABS_REQUEST_DELAY_MS = 300;
const AIRLABS_SCHEDULES_LOOKUP_BASE = 'https://airlabs.co/api/v9/schedules';
const AIRPORT_TZ_LOOKUP_URL = 'https://raw.githubusercontent.com/mwgg/Airports/master/airports.json';
const AIRPORT_TZ_FALLBACK = { YYZ: 'America/Toronto', CYYZ: 'America/Toronto' };
const CALENDAR_FLIGHT_PREFIXES = new Set(['RV', 'AC', 'QK']);
const DEADHEAD_PREFIX = 'DH';
const TORONTO_TIMEZONE = 'America/Toronto';
const TORONTO_SYNC_HOUR = 23;
const TORONTO_SYNC_MINUTE = 0;

let airportTimezonePromise = null;
let airportTimezoneCache = { ...AIRPORT_TZ_FALLBACK };
let calendarAirlabsLastRequestAt = 0;

function jsonResponse(body, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), {
    status: options.status || 200,
    headers
  });
}

function withCors(headers, origin) {
  const next = new Headers(headers || {});
  next.set('X-AC-Pay-Schema', String(CALENDAR_SCHEMA_VERSION));
  if (origin) {
    next.set('Access-Control-Allow-Origin', origin);
    next.set('Vary', 'Origin');
  }
  next.set('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  next.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-None-Match, X-API-Key, x-api-key, x-apikey, API-Version, Accept-Version');
  next.set('Access-Control-Expose-Headers', 'ETag, X-AC-Pay-Schema');
  return next;
}

function isAuthorized(request, env) {
  const token = env.SYNC_TOKEN;
  if (!token) {
    return false;
  }
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${token}`;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, message: 'Payload must be a JSON object.' };
  }
  const requiredKeys = ['eventsByDate', 'months', 'selectedMonth', 'blockMonthsByMonthKey', 'blockMonthRecurring'];
  const optionalKeys = ['hotels'];
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(payload);
  const missing = requiredKeys.filter(key => !(key in payload));
  if (missing.length) {
    return { ok: false, message: `Missing keys: ${missing.join(', ')}` };
  }
  const unexpected = keys.filter(key => !allowedKeys.has(key));
  if (unexpected.length) {
    return { ok: false, message: `Unexpected keys: ${unexpected.join(', ')}` };
  }
  if (typeof payload.eventsByDate !== 'object' || payload.eventsByDate === null || Array.isArray(payload.eventsByDate)) {
    return { ok: false, message: 'eventsByDate must be an object.' };
  }
  if (!Array.isArray(payload.months)) {
    return { ok: false, message: 'months must be an array.' };
  }
  if (payload.selectedMonth !== null && typeof payload.selectedMonth !== 'string') {
    return { ok: false, message: 'selectedMonth must be a string or null.' };
  }
  const blockMonthsValue = payload.blockMonthsByMonthKey;
  if (typeof blockMonthsValue !== 'object' || blockMonthsValue === null || Array.isArray(blockMonthsValue)) {
    return { ok: false, message: 'blockMonthsByMonthKey must be an object.' };
  }
  for (const entry of Object.values(blockMonthsValue)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, message: 'blockMonthsByMonthKey entries must be objects.' };
    }
    if (typeof entry.startKey !== 'string' || !entry.startKey.trim()) {
      return { ok: false, message: 'blockMonthsByMonthKey entries must include startKey.' };
    }
    if ('endKey' in entry && entry.endKey !== null && typeof entry.endKey !== 'string') {
      return { ok: false, message: 'blockMonthsByMonthKey endKey must be a string or null.' };
    }
  }
  const blockRecurringValue = payload.blockMonthRecurring;
  if (typeof blockRecurringValue !== 'object' || blockRecurringValue === null || Array.isArray(blockRecurringValue)) {
    return { ok: false, message: 'blockMonthRecurring must be an object.' };
  }
  for (const entry of Object.values(blockRecurringValue)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, message: 'blockMonthRecurring entries must be objects.' };
    }
    if (!Number.isFinite(entry.startDay)) {
      return { ok: false, message: 'blockMonthRecurring entries must include startDay.' };
    }
    if ('endDay' in entry && entry.endDay !== null && !Number.isFinite(entry.endDay)) {
      return { ok: false, message: 'blockMonthRecurring endDay must be a number or null.' };
    }
  }
  if ('hotels' in payload) {
    if (!Array.isArray(payload.hotels)) {
      return { ok: false, message: 'hotels must be an array.' };
    }
    for (const entry of payload.hotels) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { ok: false, message: 'hotels entries must be objects.' };
      }
      if (typeof entry.id !== 'string' || !entry.id.trim()) {
        return { ok: false, message: 'hotels entries must include id.' };
      }
      if (typeof entry.name !== 'string') {
        return { ok: false, message: 'hotels entries must include name.' };
      }
      if (typeof entry.startKey !== 'string' || !entry.startKey.trim()) {
        return { ok: false, message: 'hotels entries must include startKey.' };
      }
      if ('endKey' in entry && entry.endKey !== null && typeof entry.endKey !== 'string') {
        return { ok: false, message: 'hotels endKey must be a string or null.' };
      }
    }
  }
  return { ok: true };
}

async function computeEtag(payload) {
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(payload));
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = Array.from(new Uint8Array(hash));
  return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeCalendarRecord(stored) {
  const defaultPayload = {
    eventsByDate: {},
    months: [],
    selectedMonth: null,
    blockMonthsByMonthKey: {},
    blockMonthRecurring: {},
    hotels: [],
    updatedAt: null,
    etag: null
  };
  return stored
    ? {
      ...defaultPayload,
      ...stored,
      eventsByDate: stored.eventsByDate && typeof stored.eventsByDate === 'object' ? stored.eventsByDate : {},
      months: Array.isArray(stored.months) ? stored.months : [],
      selectedMonth: typeof stored.selectedMonth === 'string' ? stored.selectedMonth : null,
      blockMonthsByMonthKey: stored.blockMonthsByMonthKey || {},
      blockMonthRecurring: stored.blockMonthRecurring || {},
      hotels: Array.isArray(stored.hotels) ? stored.hotels : []
    }
    : defaultPayload;
}

function buildCalendarRecordPayload(record) {
  return {
    eventsByDate: record.eventsByDate,
    months: record.months,
    selectedMonth: record.selectedMonth,
    blockMonthsByMonthKey: record.blockMonthsByMonthKey,
    blockMonthRecurring: record.blockMonthRecurring,
    hotels: record.hotels
  };
}

function parseDateKeyParts(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

function getDateKeyStartMs(dateKey) {
  if (!dateKey) return NaN;
  const parts = parseDateKeyParts(dateKey);
  if (!parts) return NaN;
  return new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0).getTime();
}

function normalizeCalendarDateKey(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeAirportCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3,4}$/.test(code) ? code : '';
}

function normalizeCallsign(value) {
  return String(value || '').trim().toUpperCase();
}

function parseCalendarFlightPrefix(rawPrefix) {
  const normalized = String(rawPrefix || '').toUpperCase();
  if (normalized.startsWith(`${DEADHEAD_PREFIX}/`)) {
    return { prefix: normalized.slice(3), deadhead: true };
  }
  return { prefix: normalized, deadhead: false };
}

function hasAllowedCalendarFlightPrefix(prefix) {
  const { prefix: normalizedPrefix } = parseCalendarFlightPrefix(prefix);
  return CALENDAR_FLIGHT_PREFIXES.has(normalizedPrefix);
}

function isDeadheadIdentifier(identifier) {
  const compact = String(identifier || '').toUpperCase().replace(/\s+/g, '');
  return compact.startsWith(`${DEADHEAD_PREFIX}/`);
}

function isDeadheadEvent(event) {
  if (event?.deadhead || event?.isDeadhead) return true;
  const identifiers = Array.isArray(event?.identifiers) ? event.identifiers : [];
  return identifiers.some(isDeadheadIdentifier);
}

function isPairingMarkerEvent(event) {
  return Boolean(event?.isPairingMarker);
}

function isCalendarCancelledEvent(event) {
  const cancellation = String(event?.cancellation || '').trim().toUpperCase();
  return cancellation === 'CNX' || cancellation === 'CNX PP';
}

function isCalendarFlightTimesAlreadyUpdated(event) {
  if (!event || typeof event !== 'object') return false;
  const hasDeparture = Number.isFinite(Number(event.departureMinutes));
  const hasArrival = Number.isFinite(Number(event.arrivalMinutes));
  if (!hasDeparture || !hasArrival) return false;
  const source = String(event.timeSource || '').trim().toLowerCase();
  if (source === 'manual' || source === 'airlabs') return true;
  const status = String(event?.gateTimeSync?.status || '').trim().toLowerCase();
  const provider = String(event?.gateTimeSync?.provider || '').trim().toLowerCase();
  return status === 'success' && provider === 'airlabs';
}

function extractCalendarFlightIdentifier(event) {
  const identifiers = Array.isArray(event?.identifiers) ? event.identifiers : [];
  const parseIdentifier = (value) => {
    const compact = String(value || '').toUpperCase().replace(/\s+/g, '');
    if (!compact) return null;
    let deadhead = false;
    let working = compact;
    if (working.startsWith(`${DEADHEAD_PREFIX}/`)) {
      deadhead = true;
      working = working.slice(3);
    }
    if (!/^[A-Z]{2}\d{1,4}$/.test(working)) return null;
    const prefix = working.slice(0, 2);
    const number = working.slice(2);
    const prefixKey = deadhead ? `${DEADHEAD_PREFIX}/${prefix}` : prefix;
    if (!hasAllowedCalendarFlightPrefix(prefixKey)) return null;
    return { prefix, number, deadhead, raw: working };
  };
  for (const id of identifiers) {
    const match = parseIdentifier(id);
    if (match) return match;
  }
  return parseIdentifier(event?.label || '');
}

function buildCalendarAirlabsFlightIcaoCandidates(prefix, number) {
  const normalizedPrefix = String(prefix || '').toUpperCase();
  const normalizedNumber = String(number || '').replace(/\s+/g, '');
  if (!normalizedPrefix || !normalizedNumber) return [];
  const mapping = { AC: 'ACA', RV: 'ROU', QK: 'JZA' };
  const mappedPrefix = mapping[normalizedPrefix] || normalizedPrefix;
  return Array.from(new Set([`${mappedPrefix}${normalizedNumber}`]));
}

function parseCalendarApiTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value / 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isFinite(num)) return null;
      return num > 1e12 ? Math.round(num / 1000) : Math.round(num);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
  }
  return null;
}

function getAirlabsField(entry, path) {
  if (!entry || !path) return null;
  return path.split('.').reduce((value, key) => {
    if (value === null || value === undefined || typeof value !== 'object') return null;
    return value[key];
  }, entry);
}

function extractAirlabsActualGateTimes(flight) {
  const departurePaths = [
    'dep_actual_ts',
    'dep_actual',
    'dep_actual_time',
    'departure.actual_ts',
    'departure.actual',
    'departure.actual_time',
    'dep.actual_ts',
    'dep.actual',
    'dep.actual_time'
  ];
  const arrivalPaths = [
    'arr_actual_ts',
    'arr_actual',
    'arr_actual_time',
    'arrival.actual_ts',
    'arrival.actual',
    'arrival.actual_time',
    'arr.actual_ts',
    'arr.actual',
    'arr.actual_time'
  ];
  let gateDeparture = null;
  for (const path of departurePaths) {
    const parsed = parseCalendarApiTimestamp(getAirlabsField(flight, path));
    if (Number.isFinite(parsed)) {
      gateDeparture = parsed;
      break;
    }
  }
  let gateArrival = null;
  for (const path of arrivalPaths) {
    const parsed = parseCalendarApiTimestamp(getAirlabsField(flight, path));
    if (Number.isFinite(parsed)) {
      gateArrival = parsed;
      break;
    }
  }
  return {
    gate_departure: Number.isFinite(gateDeparture) ? gateDeparture : null,
    gate_arrival: Number.isFinite(gateArrival) ? gateArrival : null
  };
}

function setAirlabsAirportParam(url, prefix, code) {
  const normalized = normalizeAirportCode(code);
  if (!normalized) return false;
  if (normalized.length === 3) {
    url.searchParams.set(`${prefix}_iata`, normalized);
    return true;
  }
  if (normalized.length === 4) {
    url.searchParams.set(`${prefix}_icao`, normalized);
    return true;
  }
  return false;
}

function extractAirlabsAirportCode(flight, prefix) {
  const iata = normalizeAirportCode(
    getAirlabsField(flight, `${prefix}_iata`)
    || getAirlabsField(flight, `${prefix}.iata`)
    || getAirlabsField(flight, `${prefix}_airport_iata`)
    || getAirlabsField(flight, `${prefix}_airport.iata`)
  );
  const icao = normalizeAirportCode(
    getAirlabsField(flight, `${prefix}_icao`)
    || getAirlabsField(flight, `${prefix}.icao`)
    || getAirlabsField(flight, `${prefix}_airport_icao`)
    || getAirlabsField(flight, `${prefix}_airport.icao`)
  );
  return { iata, icao };
}

function collectAirlabsFlightIdentifiers(flight) {
  const ids = new Set();
  const add = (value) => {
    const normalized = normalizeCallsign(value);
    if (normalized) ids.add(normalized);
  };
  add(flight?.flight_icao);
  add(flight?.flight_iata);
  add(flight?.ident_icao);
  add(flight?.ident_iata);
  const flightNumber = String(
    flight?.flight_number
    ?? getAirlabsField(flight, 'flight.number')
    ?? ''
  ).replace(/\s+/g, '');
  const airlineIcao = normalizeCallsign(
    flight?.airline_icao
    ?? getAirlabsField(flight, 'airline.icao')
  );
  const airlineIata = normalizeCallsign(
    flight?.airline_iata
    ?? getAirlabsField(flight, 'airline.iata')
  );
  if (flightNumber && airlineIcao) add(`${airlineIcao}${flightNumber}`);
  if (flightNumber && airlineIata) add(`${airlineIata}${flightNumber}`);
  return ids;
}

function doesAirlabsFlightMatchRoute(flight, { depCode = '', arrCode = '' } = {}) {
  const expectedDep = normalizeAirportCode(depCode);
  const expectedArr = normalizeAirportCode(arrCode);
  const dep = extractAirlabsAirportCode(flight, 'dep');
  const arr = extractAirlabsAirportCode(flight, 'arr');
  const depMatch = !expectedDep || dep.iata === expectedDep || dep.icao === expectedDep;
  const arrMatch = !expectedArr || arr.iata === expectedArr || arr.icao === expectedArr;
  return depMatch && arrMatch;
}

function doesAirlabsFlightMatchCallsign(flight, flightIcao) {
  const expected = normalizeCallsign(flightIcao);
  if (!expected) return true;
  return collectAirlabsFlightIdentifiers(flight).has(expected);
}

function scoreAirlabsScheduleRecord(flight, expected) {
  let score = 0;
  if (doesAirlabsFlightMatchCallsign(flight, expected?.flightIcao)) score += 5;
  if (doesAirlabsFlightMatchRoute(flight, expected)) score += 3;
  const gateTimes = extractAirlabsActualGateTimes(flight);
  if (Number.isFinite(gateTimes.gate_departure)) score += 1;
  if (Number.isFinite(gateTimes.gate_arrival)) score += 1;
  return score;
}

function selectAirlabsScheduleFlight(list, expected = {}) {
  const rows = Array.isArray(list) ? list.filter((entry) => entry && typeof entry === 'object') : [];
  if (!rows.length) return null;
  const ranked = rows
    .map((flight) => ({ flight, score: scoreAirlabsScheduleRecord(flight, expected) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score <= 0) return null;
  return best.flight;
}

function sleepMs(duration) {
  const ms = Number(duration);
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCalendarAirlabsRequestSlot() {
  const now = Date.now();
  const elapsed = now - calendarAirlabsLastRequestAt;
  if (elapsed < CALENDAR_AIRLABS_REQUEST_DELAY_MS) {
    await sleepMs(CALENDAR_AIRLABS_REQUEST_DELAY_MS - elapsed);
  }
  calendarAirlabsLastRequestAt = Date.now();
}

async function fetchCalendarAirlabsFlight(
  flightIcao,
  env,
  { depCode = '', arrCode = '' } = {}
) {
  const normalizedFlightIcao = normalizeCallsign(flightIcao);
  if (!normalizedFlightIcao) {
    const err = new Error('Missing flight_icao value.');
    err.code = 'invalidFlight';
    throw err;
  }
  const apiKey = String(env.AIRLABS_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('Airlabs API key not configured.');
    err.code = 'missingApiKey';
    throw err;
  }
  await waitForCalendarAirlabsRequestSlot();
  const normalizedDep = normalizeAirportCode(depCode);
  const normalizedArr = normalizeAirportCode(arrCode);
  const url = new URL(AIRLABS_SCHEDULES_LOOKUP_BASE);
  const hasDep = setAirlabsAirportParam(url, 'dep', normalizedDep);
  const hasArr = setAirlabsAirportParam(url, 'arr', normalizedArr);
  if (!hasDep && !hasArr) {
    const err = new Error('Missing dep/arr airport code for AirLabs schedules lookup.');
    err.code = 'missingRoute';
    throw err;
  }
  url.searchParams.set('api_key', apiKey);
  const resp = await fetch(url.toString(), { method: 'GET', cache: 'no-store' });
  const rawText = await resp.text();
  let json = {};
  try {
    json = rawText ? JSON.parse(rawText) : {};
  } catch (_err) {
    const err = new Error('AirLabs response was not valid JSON.');
    err.code = 'invalidJson';
    throw err;
  }
  if (!resp.ok) {
    const detail = json?.error?.message || json?.error || rawText || `HTTP ${resp.status}`;
    const err = new Error(`AirLabs request failed (${resp.status}): ${detail}`);
    err.code = 'airlabsError';
    throw err;
  }
  if (json?.error) {
    const detail = typeof json.error === 'string'
      ? json.error
      : (json.error?.message || json.error?.code || 'request failed');
    const err = new Error(`AirLabs error: ${detail}`);
    err.code = 'airlabsError';
    throw err;
  }
  const payload = json?.response;
  const rows = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === 'object' ? [payload] : []);
  const flight = selectAirlabsScheduleFlight(rows, {
    flightIcao: normalizedFlightIcao,
    depCode: normalizedDep,
    arrCode: normalizedArr
  });
  if (!flight) {
    const err = new Error('AirLabs schedules response missing matching flight data.');
    err.code = 'noFlightData';
    throw err;
  }
  return flight;
}

function getCalendarEventBoundaryAirports(event) {
  const segments = Array.isArray(event?.segments) ? event.segments : [];
  if (segments.length) {
    const first = segments[0];
    const last = segments[segments.length - 1];
    const depCode = normalizeAirportCode(first?.from || '');
    const arrCode = normalizeAirportCode(last?.to || '');
    return { depCode, arrCode };
  }
  const legs = Array.isArray(event?.legs) ? event.legs : [];
  if (legs.length) {
    const first = legs[0];
    const last = legs[legs.length - 1];
    const depCode = normalizeAirportCode(first?.from || '');
    const arrCode = normalizeAirportCode(last?.to || '');
    return { depCode, arrCode };
  }
  return { depCode: '', arrCode: '' };
}

function getCalendarEventArrivalMs(event, dateKey) {
  const normalizedDateKey = normalizeCalendarDateKey(dateKey || event?.date);
  if (!normalizedDateKey) return NaN;
  const dayStartMs = getDateKeyStartMs(normalizedDateKey);
  if (!Number.isFinite(dayStartMs)) return NaN;
  const arrivalMinutes = Number(event?.arrivalMinutes);
  if (!Number.isFinite(arrivalMinutes)) return NaN;
  const departureMinutes = Number(event?.departureMinutes);
  const overnightMinutes = Number.isFinite(departureMinutes) && arrivalMinutes < departureMinutes
    ? arrivalMinutes + 1440
    : arrivalMinutes;
  return dayStartMs + (overnightMinutes * 60000);
}

function getCalendarGateSyncProviderForArrivalAge(arrivalAgeMs, env) {
  if (!Number.isFinite(arrivalAgeMs) || arrivalAgeMs < 0) return 'skip';
  if (arrivalAgeMs > CALENDAR_GATE_SYNC_LOOKBACK_MS) return 'skip';
  return String(env.AIRLABS_API_KEY || '').trim() ? 'airlabs' : 'skip';
}

function getCalendarGateSyncAttemptCount(event) {
  const attempts = Number(event?.gateTimeSync?.attemptCount);
  if (!Number.isFinite(attempts) || attempts <= 0) return 0;
  return Math.max(0, Math.trunc(attempts));
}

function hasRecentCalendarGateSyncFailure(event, nowMs = Date.now()) {
  if (!event || typeof event !== 'object') return false;
  const sync = event.gateTimeSync;
  if (!sync || typeof sync !== 'object') return false;
  if (String(sync.status || '').toLowerCase() !== 'failed') return false;
  const attemptCount = Number(sync.attemptCount);
  if (sync.retryExhausted || (Number.isFinite(attemptCount) && attemptCount >= CALENDAR_GATE_SYNC_MAX_ATTEMPTS)) {
    return true;
  }
  const nextRetryAt = Number(sync.nextRetryAt);
  return Number.isFinite(nextRetryAt) && nextRetryAt > nowMs;
}

function setCalendarGateTimeSyncFailure(event, { provider = '', reason = 'applyFailed', nowMs = Date.now() } = {}) {
  if (!event || typeof event !== 'object') return;
  const nextAttemptCount = Math.min(
    CALENDAR_GATE_SYNC_MAX_ATTEMPTS,
    getCalendarGateSyncAttemptCount(event) + 1
  );
  const retryExhausted = nextAttemptCount >= CALENDAR_GATE_SYNC_MAX_ATTEMPTS;
  event.gateTimeSync = {
    status: 'failed',
    provider: String(provider || '').trim().toLowerCase() || null,
    reason: String(reason || '').trim() || 'applyFailed',
    attemptedAt: nowMs,
    attemptCount: nextAttemptCount,
    nextRetryAt: retryExhausted ? null : (nowMs + CALENDAR_GATE_SYNC_RETRY_DELAY_MS),
    retryExhausted
  };
}

function setCalendarGateTimeSyncSuccess(event, { provider = '', nowMs = Date.now() } = {}) {
  if (!event || typeof event !== 'object') return;
  event.gateTimeSync = {
    status: 'success',
    provider: String(provider || '').trim().toLowerCase() || null,
    reason: null,
    attemptedAt: nowMs,
    attemptCount: getCalendarGateSyncAttemptCount(event),
    nextRetryAt: null,
    retryExhausted: false
  };
}

async function loadAirportTimezones() {
  if (airportTimezonePromise) return airportTimezonePromise;
  airportTimezonePromise = fetch(AIRPORT_TZ_LOOKUP_URL, { method: 'GET', cache: 'force-cache' })
    .then(async (resp) => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const list = await resp.json();
      const map = { ...AIRPORT_TZ_FALLBACK };
      if (list && typeof list === 'object') {
        Object.values(list).forEach((entry) => {
          const tz = entry?.tz;
          if (!tz) return;
          const iata = entry?.iata;
          const icao = entry?.icao;
          if (iata) map[String(iata).toUpperCase()] = tz;
          if (icao) map[String(icao).toUpperCase()] = tz;
        });
      }
      airportTimezoneCache = map;
      return map;
    })
    .catch((err) => {
      console.warn('Airport timezone fetch failed; using fallback map only.', err);
      airportTimezoneCache = { ...AIRPORT_TZ_FALLBACK };
      return { ...airportTimezoneCache };
    });
  return airportTimezonePromise;
}

function getCachedAirportTimeZone(code) {
  const lookup = airportTimezoneCache || AIRPORT_TZ_FALLBACK;
  const key = String(code || '').toUpperCase();
  return lookup[key] || (key.length === 3 ? lookup[`C${key}`] : null) || null;
}

function getLocalMinutesFromUtc(tsSeconds, timeZone) {
  const tsMs = Number(tsSeconds) * 1000;
  if (!Number.isFinite(tsMs)) return null;
  const zone = String(timeZone || '').trim();
  if (!zone) return null;
  const date = new Date(tsMs);
  if (!Number.isFinite(date.getTime())) return null;
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = dtf.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  let hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour === 24) hour = 0;
  const minutes = (hour * 60) + minute;
  if (!Number.isFinite(minutes)) return null;
  const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { dateKey, minutes };
}

function getDateKeyDayOffset(targetKey, originKey) {
  const targetStart = getDateKeyStartMs(targetKey);
  const originStart = getDateKeyStartMs(originKey);
  if (!Number.isFinite(targetStart) || !Number.isFinite(originStart)) return NaN;
  return Math.round((targetStart - originStart) / 86400000);
}

function collectCalendarGateSyncCandidates(eventsByDate, env, {
  force = false,
  skipAlreadyUpdated = true,
  nowMs = Date.now()
} = {}) {
  const candidates = [];
  if (!eventsByDate || typeof eventsByDate !== 'object') return candidates;
  const startMs = nowMs - CALENDAR_GATE_SYNC_LOOKBACK_MS;
  const endMs = nowMs;
  Object.entries(eventsByDate).forEach(([dateKey, day]) => {
    const normalizedDateKey = normalizeCalendarDateKey(dateKey);
    if (!normalizedDateKey) return;
    const events = Array.isArray(day?.events) ? day.events : [];
    events.forEach((event) => {
      if (isPairingMarkerEvent(event)) return;
      if (isCalendarCancelledEvent(event)) return;
      if (skipAlreadyUpdated && isCalendarFlightTimesAlreadyUpdated(event)) return;
      if (!force && hasRecentCalendarGateSyncFailure(event, nowMs)) return;
      const flightInfo = extractCalendarFlightIdentifier(event);
      if (!flightInfo) return;
      const { depCode, arrCode } = getCalendarEventBoundaryAirports(event);
      if (!depCode || !arrCode) return;
      const arrivalMs = getCalendarEventArrivalMs(event, normalizedDateKey);
      if (!Number.isFinite(arrivalMs)) return;
      if (arrivalMs < startMs || arrivalMs > endMs) return;
      const arrivalAgeMs = nowMs - arrivalMs;
      const provider = getCalendarGateSyncProviderForArrivalAge(arrivalAgeMs, env);
      if (provider === 'skip') return;
      const flightIcaoCandidates = buildCalendarAirlabsFlightIcaoCandidates(flightInfo.prefix, flightInfo.number);
      if (!flightIcaoCandidates.length) return;
      candidates.push({
        event,
        dateKey: normalizedDateKey,
        depCode,
        arrCode,
        arrivalMs,
        arrivalAgeMs,
        flightIcaoCandidates
      });
    });
  });
  return candidates;
}

function applyGateTimesToCalendarCandidate(candidate, gateTimes, { source = 'airlabs', nowMs = Date.now() } = {}) {
  if (!candidate) {
    return { updated: false, reason: 'applyFailed' };
  }
  if (!gateTimes) {
    setCalendarGateTimeSyncFailure(candidate.event, { provider: source, reason: 'missingActualTimes', nowMs });
    return { updated: false, reason: 'missingActualTimes' };
  }
  const hasDeparture = Number.isFinite(gateTimes.gate_departure);
  const hasArrival = Number.isFinite(gateTimes.gate_arrival);
  if (!hasDeparture || !hasArrival) {
    const reason = !hasDeparture && !hasArrival
      ? 'missingActualTimes'
      : (!hasDeparture ? 'missingActualDeparture' : 'missingActualArrival');
    setCalendarGateTimeSyncFailure(candidate.event, { provider: source, reason, nowMs });
    if (!hasDeparture && !hasArrival) return { updated: false, reason: 'missingActualTimes' };
    if (!hasDeparture) return { updated: false, reason: 'missingActualDeparture' };
    return { updated: false, reason: 'missingActualArrival' };
  }
  const depZone = getCachedAirportTimeZone(candidate.depCode);
  const arrZone = getCachedAirportTimeZone(candidate.arrCode);
  if (!depZone || !arrZone) {
    setCalendarGateTimeSyncFailure(candidate.event, { provider: source, reason: 'timezoneMissing', nowMs });
    return { updated: false, reason: 'timezoneMissing' };
  }
  const depLocal = getLocalMinutesFromUtc(gateTimes.gate_departure, depZone);
  const arrLocal = getLocalMinutesFromUtc(gateTimes.gate_arrival, arrZone);
  if (!depLocal || !arrLocal) {
    setCalendarGateTimeSyncFailure(candidate.event, { provider: source, reason: 'timezoneMissing', nowMs });
    return { updated: false, reason: 'timezoneMissing' };
  }
  const depOffset = getDateKeyDayOffset(depLocal.dateKey, candidate.dateKey);
  if (!Number.isFinite(depOffset) || Math.abs(depOffset) > 1) {
    setCalendarGateTimeSyncFailure(candidate.event, { provider: source, reason: 'dateMismatch', nowMs });
    return { updated: false, reason: 'dateMismatch' };
  }
  const dayOffset = getDateKeyDayOffset(arrLocal.dateKey, depLocal.dateKey);
  if (!Number.isFinite(dayOffset) || dayOffset < 0 || dayOffset > 1) {
    setCalendarGateTimeSyncFailure(candidate.event, { provider: source, reason: 'dateMismatch', nowMs });
    return { updated: false, reason: 'dateMismatch' };
  }

  candidate.event.departureMinutes = depLocal.minutes;
  candidate.event.arrivalMinutes = arrLocal.minutes;
  if (Array.isArray(candidate.event?.segments) && candidate.event.segments.length) {
    const firstSeg = candidate.event.segments[0];
    if (firstSeg && typeof firstSeg === 'object') {
      firstSeg.departureMinutes = depLocal.minutes;
    }
    const lastSeg = candidate.event.segments[candidate.event.segments.length - 1];
    if (lastSeg && typeof lastSeg === 'object') {
      lastSeg.arrivalMinutes = arrLocal.minutes;
    }
  }
  candidate.event.timeSource = source;

  const overnightMinutes = arrLocal.minutes < depLocal.minutes
    ? arrLocal.minutes + 1440
    : arrLocal.minutes;
  const localBlockMinutes = Math.max(0, overnightMinutes - depLocal.minutes);
  if (Number.isFinite(localBlockMinutes)) {
    candidate.event.blockMinutes = localBlockMinutes;
    candidate.event.creditMinutes = isDeadheadEvent(candidate.event)
      ? Math.round(localBlockMinutes * 0.5)
      : localBlockMinutes;
  }

  setCalendarGateTimeSyncSuccess(candidate.event, { provider: source, nowMs });
  return { updated: true, reason: null };
}

function buildCalendarMonths(eventsByDate) {
  const months = new Set();
  Object.keys(eventsByDate || {}).forEach((dateKey) => {
    if (typeof dateKey === 'string' && dateKey.length >= 7) {
      months.add(dateKey.slice(0, 7));
    }
  });
  return Array.from(months).sort();
}

async function runCalendarGateTimeAutoSync(record, env, {
  force = false,
  skipAlreadyUpdated = !force
} = {}) {
  const nowMs = Date.now();
  const shouldSkipUpdated = force ? false : Boolean(skipAlreadyUpdated);
  const candidates = collectCalendarGateSyncCandidates(record.eventsByDate, env, {
    force,
    skipAlreadyUpdated: shouldSkipUpdated,
    nowMs
  });
  if (!candidates.length) {
    return { mutated: false, updatedCount: 0, failedCount: 0 };
  }

  await loadAirportTimezones();

  let mutated = false;
  let updatedCount = 0;
  let failedCount = 0;

  for (const candidate of candidates) {
    let flightMatch = null;
    let gateTimes = null;
    let lookupErrorCount = 0;
    let noDataCount = 0;

    for (const flightIcao of (candidate.flightIcaoCandidates || [])) {
      try {
        const flight = await fetchCalendarAirlabsFlight(flightIcao, env, {
          depCode: candidate.depCode,
          arrCode: candidate.arrCode
        });
        flightMatch = flight;
        gateTimes = extractAirlabsActualGateTimes(flight);
        break;
      } catch (err) {
        if (err?.code === 'noFlightData') {
          noDataCount += 1;
        } else {
          lookupErrorCount += 1;
        }
      }
    }

    if (!flightMatch) {
      failedCount += 1;
      let failureReason = 'noAirlabsMatch';
      if (lookupErrorCount > 0) {
        failureReason = 'lookupError';
      } else if (!noDataCount) {
        failureReason = 'applyFailed';
      }
      setCalendarGateTimeSyncFailure(candidate.event, { provider: 'airlabs', reason: failureReason, nowMs: Date.now() });
      mutated = true;
      continue;
    }

    const outcome = applyGateTimesToCalendarCandidate(candidate, gateTimes, {
      source: 'airlabs',
      nowMs: Date.now()
    });
    if (outcome?.updated) {
      updatedCount += 1;
    } else {
      failedCount += 1;
    }
    mutated = true;
  }

  if (mutated) {
    record.months = buildCalendarMonths(record.eventsByDate);
  }

  return { mutated, updatedCount, failedCount };
}

async function handleGet(env, origin) {
  const stored = await env.AC_PAY_CALENDAR.get(CALENDAR_KEY, 'json');
  const payload = normalizeCalendarRecord(stored);
  const headers = withCors({ ETag: payload.etag || '' }, origin);
  return jsonResponse(
    {
      eventsByDate: payload.eventsByDate,
      months: payload.months,
      selectedMonth: payload.selectedMonth,
      blockMonthsByMonthKey: payload.blockMonthsByMonthKey,
      blockMonthRecurring: payload.blockMonthRecurring,
      hotels: payload.hotels,
      updatedAt: payload.updatedAt,
      etag: payload.etag
    },
    { headers }
  );
}

async function handlePut(request, env, origin) {
  let payload;
  try {
    payload = await request.json();
  } catch (error) {
    return jsonResponse({ error: 'Invalid JSON payload.' }, { status: 400, headers: withCors({}, origin) });
  }
  const validation = validatePayload(payload);
  if (!validation.ok) {
    return jsonResponse(
      { error: validation.message, message: validation.message },
      { status: 400, headers: withCors({}, origin) }
    );
  }
  const updatedAt = new Date().toISOString();
  const blockMonthsByMonthKey = payload.blockMonthsByMonthKey || {};
  const blockMonthRecurring = payload.blockMonthRecurring || {};
  const hotels = Array.isArray(payload.hotels) ? payload.hotels : [];
  const etag = await computeEtag({
    eventsByDate: payload.eventsByDate,
    months: payload.months,
    selectedMonth: payload.selectedMonth,
    blockMonthsByMonthKey,
    blockMonthRecurring,
    hotels
  });
  const record = {
    eventsByDate: payload.eventsByDate,
    months: payload.months,
    selectedMonth: payload.selectedMonth,
    blockMonthsByMonthKey,
    blockMonthRecurring,
    hotels,
    updatedAt,
    etag
  };
  await env.AC_PAY_CALENDAR.put(CALENDAR_KEY, JSON.stringify(record));
  const headers = withCors({ ETag: etag }, origin);
  return jsonResponse({ updatedAt, etag }, { status: 200, headers });
}

async function handleAirlabsProxy(request, env, origin) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: withCors({}, origin) });
  }
  if (!String(env.AIRLABS_API_KEY || '').trim()) {
    return jsonResponse(
      { error: 'Airlabs API key not configured.' },
      { status: 503, headers: withCors({}, origin) }
    );
  }
  const requestUrl = new URL(request.url);
  const flightIcao = normalizeCallsign(requestUrl.searchParams.get('flight_icao') || '');
  const depCode = normalizeAirportCode(requestUrl.searchParams.get('dep_code') || '');
  const arrCode = normalizeAirportCode(requestUrl.searchParams.get('arr_code') || '');
  if (!flightIcao) {
    return jsonResponse(
      { error: 'Missing flight_icao query parameter.' },
      { status: 400, headers: withCors({}, origin) }
    );
  }

  try {
    const flight = await fetchCalendarAirlabsFlight(flightIcao, env, { depCode, arrCode });
    const headers = withCors({ 'Content-Type': 'application/json' }, origin);
    return jsonResponse({ response: flight }, { status: 200, headers });
  } catch (err) {
    const status = err?.code === 'missingApiKey'
      ? 503
      : (err?.code === 'invalidFlight' || err?.code === 'missingRoute'
        ? 400
        : (err?.code === 'noFlightData' ? 404 : 502));
    return jsonResponse(
      { error: err?.message || `Unable to reach AirLabs: ${err}` },
      { status, headers: withCors({}, origin) }
    );
  }
}

function isTorontoSyncWindow(scheduledTime) {
  const date = new Date(Number.isFinite(Number(scheduledTime)) ? Number(scheduledTime) : Date.now());
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TORONTO_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return hour === TORONTO_SYNC_HOUR && minute === TORONTO_SYNC_MINUTE;
}

async function runScheduledGateSync(env, scheduledTime) {
  if (!env.AC_PAY_CALENDAR) {
    console.warn('Calendar storage not configured; skipping scheduled gate sync.');
    return { mutated: false, updatedCount: 0, failedCount: 0, skipped: 'missingStorage' };
  }
  if (!String(env.AIRLABS_API_KEY || '').trim()) {
    console.warn('AIRLABS_API_KEY missing; skipping scheduled gate sync.');
    return { mutated: false, updatedCount: 0, failedCount: 0, skipped: 'missingAirlabsKey' };
  }

  const stored = await env.AC_PAY_CALENDAR.get(CALENDAR_KEY, 'json');
  const record = normalizeCalendarRecord(stored);
  const result = await runCalendarGateTimeAutoSync(record, env, {
    force: false,
    skipAlreadyUpdated: true
  });

  if (!result.mutated) {
    return result;
  }

  const updatedAt = new Date(Number.isFinite(Number(scheduledTime)) ? Number(scheduledTime) : Date.now()).toISOString();
  const payloadForHash = buildCalendarRecordPayload(record);
  const etag = await computeEtag(payloadForHash);
  const nextRecord = {
    ...record,
    ...payloadForHash,
    updatedAt,
    etag
  };
  await env.AC_PAY_CALENDAR.put(CALENDAR_KEY, JSON.stringify(nextRecord));
  return { ...result, updatedAt, etag };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestOrigin = request.headers.get('Origin') || '';
    const configuredOrigin = env.PWA_ORIGIN ? env.PWA_ORIGIN.trim() : '';
    const allowedOrigins = [
      'https://happypanda2222.github.io',
      configuredOrigin
    ].filter(Boolean);
    const origin = allowedOrigins.includes(requestOrigin) ? requestOrigin : '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCors({}, origin) });
    }

    if (url.pathname.startsWith('/fr24/')) {
      if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405, headers: withCors({}, origin) });
      }
      const upstreamPath = url.pathname.replace(/^\/fr24\/?/, '');
      const upstreamUrl = new URL(upstreamPath, 'https://fr24api.flightradar24.com/api/');
      upstreamUrl.search = url.search;
      const upstreamHeaders = new Headers();
      const forwardHeader = (name) => {
        const value = request.headers.get(name);
        if (value) upstreamHeaders.set(name, value);
      };
      ['authorization', 'x-api-key', 'api-version', 'accept-version', 'accept'].forEach(forwardHeader);
      const resp = await fetch(upstreamUrl.toString(), {
        method: 'GET',
        headers: upstreamHeaders,
        cache: 'no-store'
      });
      const responseHeaders = withCors({
        'Content-Type': resp.headers.get('Content-Type') || 'application/json'
      }, origin);
      return new Response(resp.body, { status: resp.status, headers: responseHeaders });
    }

    if (url.pathname.startsWith('/airlabs/flight')) {
      if (!isAuthorized(request, env)) {
        return jsonResponse({ error: 'Unauthorized.' }, { status: 401, headers: withCors({}, origin) });
      }
      return handleAirlabsProxy(request, env, origin);
    }

    if (!url.pathname.startsWith('/sync/calendar')) {
      return new Response('Not found', { status: 404, headers: withCors({}, origin) });
    }

    if (!env.AC_PAY_CALENDAR) {
      return jsonResponse(
        { error: 'Calendar storage not configured.' },
        { status: 503, headers: withCors({}, origin) }
      );
    }

    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: 'Unauthorized.' }, { status: 401, headers: withCors({}, origin) });
    }

    if (request.method === 'GET') {
      return handleGet(env, origin);
    }

    if (request.method === 'PUT') {
      return handlePut(request, env, origin);
    }

    return new Response('Method Not Allowed', { status: 405, headers: withCors({}, origin) });
  },

  async scheduled(event, env, ctx) {
    const scheduledTime = Number(event?.scheduledTime) || Date.now();
    if (!isTorontoSyncWindow(scheduledTime)) {
      return;
    }
    ctx.waitUntil((async () => {
      try {
        const result = await runScheduledGateSync(env, scheduledTime);
        console.log('Scheduled gate sync complete', {
          updatedCount: result.updatedCount || 0,
          failedCount: result.failedCount || 0,
          mutated: Boolean(result.mutated),
          skipped: result.skipped || null
        });
      } catch (err) {
        console.error('Scheduled gate sync failed', err);
      }
    })());
  }
};
