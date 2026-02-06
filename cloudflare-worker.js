const CALENDAR_KEY = 'calendar:default';
const CALENDAR_SCHEMA_VERSION = 3;
const CALENDAR_GATE_SYNC_LOOKBACK_MS = 30 * 60 * 60 * 1000;
const CALENDAR_GATE_SYNC_INITIAL_DELAY_MS = 30 * 60 * 1000;
const CALENDAR_GATE_SYNC_RETRY_MIN_DELAY_MS = 60 * 60 * 1000;
const CALENDAR_GATE_SYNC_MAX_ATTEMPTS = 5;
const CALENDAR_AIRLABS_REQUEST_DELAY_MS = 300;
const AIRLABS_SCHEDULES_LOOKUP_BASE = 'https://airlabs.co/api/v9/schedules';
const AIRPORT_TZ_LOOKUP_URL = 'https://raw.githubusercontent.com/mwgg/Airports/master/airports.json';
const AIRPORT_TZ_FALLBACK = { YYZ: 'America/Toronto', CYYZ: 'America/Toronto' };
const CALENDAR_FLIGHT_PREFIXES = new Set(['RV', 'AC', 'QK']);
const DEADHEAD_PREFIX = 'DH';

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
  if (source === 'manual') return true;
  if (source === 'airlabs') {
    const sync = event?.gateTimeSync;
    if (!sync || typeof sync !== 'object') return true;
    const status = String(sync.status || '').trim().toLowerCase();
    const arrivalSource = String(sync.arrivalSource || '').trim().toLowerCase();
    if (status === 'success' && (!arrivalSource || arrivalSource === 'actual')) return true;
    return false;
  }
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

function parseAirlabsLocalDateTime(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const fullMatch = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (fullMatch) {
    const year = Number(fullMatch[1]);
    const month = Number(fullMatch[2]);
    const day = Number(fullMatch[3]);
    const hour = Number(fullMatch[4] ?? '0');
    const minute = Number(fullMatch[5] ?? '0');
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return {
      dateKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      minutes: (hour * 60) + minute
    };
  }
  const timeMatch = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!timeMatch) return null;
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { dateKey: null, minutes: (hour * 60) + minute };
}

function getAirlabsField(entry, path) {
  if (!entry || !path) return null;
  return path.split('.').reduce((value, key) => {
    if (value === null || value === undefined || typeof value !== 'object') return null;
    return value[key];
  }, entry);
}

function extractAirlabsActualGateTimes(flight) {
  const departureTsPaths = [
    'dep_actual_ts',
    'departure.actual_ts',
    'dep.actual_ts'
  ];
  const arrivalTsPaths = [
    'arr_actual_ts',
    'arrival.actual_ts',
    'arr.actual_ts'
  ];
  const arrivalEstimatedTsPaths = [
    'arr_estimated_ts',
    'arrival.estimated_ts',
    'arr.estimated_ts'
  ];
  const departureLocalPaths = [
    'dep_actual',
    'dep_actual_time',
    'departure.actual',
    'departure.actual_time',
    'dep.actual',
    'dep.actual_time'
  ];
  const arrivalLocalPaths = [
    'arr_actual',
    'arr_actual_time',
    'arrival.actual',
    'arrival.actual_time',
    'arr.actual',
    'arr.actual_time'
  ];
  const arrivalEstimatedLocalPaths = [
    'arr_estimated',
    'arr_estimated_time',
    'arrival.estimated',
    'arrival.estimated_time',
    'arr.estimated',
    'arr.estimated_time'
  ];
  let gateDeparture = null;
  for (const path of departureTsPaths) {
    const parsed = parseCalendarApiTimestamp(getAirlabsField(flight, path));
    if (Number.isFinite(parsed)) {
      gateDeparture = parsed;
      break;
    }
  }
  let gateArrival = null;
  for (const path of arrivalTsPaths) {
    const parsed = parseCalendarApiTimestamp(getAirlabsField(flight, path));
    if (Number.isFinite(parsed)) {
      gateArrival = parsed;
      break;
    }
  }
  let gateArrivalEstimated = null;
  for (const path of arrivalEstimatedTsPaths) {
    const parsed = parseCalendarApiTimestamp(getAirlabsField(flight, path));
    if (Number.isFinite(parsed)) {
      gateArrivalEstimated = parsed;
      break;
    }
  }
  let localDeparture = null;
  for (const path of departureLocalPaths) {
    const parsed = parseAirlabsLocalDateTime(getAirlabsField(flight, path));
    if (parsed) {
      localDeparture = parsed;
      break;
    }
  }
  let localArrival = null;
  for (const path of arrivalLocalPaths) {
    const parsed = parseAirlabsLocalDateTime(getAirlabsField(flight, path));
    if (parsed) {
      localArrival = parsed;
      break;
    }
  }
  let localArrivalEstimated = null;
  for (const path of arrivalEstimatedLocalPaths) {
    const parsed = parseAirlabsLocalDateTime(getAirlabsField(flight, path));
    if (parsed) {
      localArrivalEstimated = parsed;
      break;
    }
  }
  return {
    gate_departure: Number.isFinite(gateDeparture) ? gateDeparture : null,
    gate_arrival: Number.isFinite(gateArrival) ? gateArrival : null,
    gate_arrival_estimated: Number.isFinite(gateArrivalEstimated) ? gateArrivalEstimated : null,
    local_departure: localDeparture || null,
    local_arrival: localArrival || null,
    local_arrival_estimated: localArrivalEstimated || null
  };
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
  const hasExpectedRoute = Boolean(normalizeAirportCode(expected?.depCode) || normalizeAirportCode(expected?.arrCode));
  if (hasExpectedRoute && doesAirlabsFlightMatchRoute(flight, expected)) score += 3;
  const gateTimes = extractAirlabsActualGateTimes(flight);
  if (gateTimes.local_departure || Number.isFinite(gateTimes.gate_departure)) score += 1;
  if (gateTimes.local_arrival || Number.isFinite(gateTimes.gate_arrival)) score += 1;
  return score;
}

function selectAirlabsScheduleFlight(list, expected = {}) {
  const rows = Array.isArray(list) ? list.filter((entry) => entry && typeof entry === 'object') : [];
  if (!rows.length) return null;
  const expectedCallsign = normalizeCallsign(expected?.flightIcao);
  const callsignMatches = expectedCallsign
    ? rows.filter((flight) => doesAirlabsFlightMatchCallsign(flight, expectedCallsign))
    : rows;
  const pool = callsignMatches.length ? callsignMatches : rows;
  const ranked = pool
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
  url.searchParams.set('flight_icao', normalizedFlightIcao);
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

function normalizeCalendarGateSyncArrivalSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'actual' || normalized === 'estimated') return normalized;
  return null;
}

function buildCalendarGateSyncNextRetryAt({ nowMs = Date.now(), arrEstimatedMs = NaN } = {}) {
  const oneHourFromNow = nowMs + CALENDAR_GATE_SYNC_RETRY_MIN_DELAY_MS;
  if (Number.isFinite(arrEstimatedMs)) {
    return Math.max(oneHourFromNow, arrEstimatedMs);
  }
  return oneHourFromNow;
}

function getCalendarGateSyncDueAt(event, arrivalMs) {
  const nextRetryAt = Number(event?.gateTimeSync?.nextRetryAt);
  if (Number.isFinite(nextRetryAt)) return nextRetryAt;
  if (!Number.isFinite(arrivalMs)) return NaN;
  return arrivalMs + CALENDAR_GATE_SYNC_INITIAL_DELAY_MS;
}

function isCalendarGateSyncDue(event, { arrivalMs = NaN, nowMs = Date.now() } = {}) {
  if (!event || typeof event !== 'object') return false;
  if (event?.gateTimeSync?.retryExhausted) return false;
  const dueAt = getCalendarGateSyncDueAt(event, arrivalMs);
  return Number.isFinite(dueAt) && dueAt <= nowMs;
}

function setCalendarGateTimeSyncPending(event, {
  provider = '',
  reason = 'awaitingActualArrival',
  arrivalSource = null,
  arrEstimatedMs = NaN,
  nowMs = Date.now()
} = {}) {
  if (!event || typeof event !== 'object') return;
  const nextAttemptCount = Math.min(
    CALENDAR_GATE_SYNC_MAX_ATTEMPTS,
    getCalendarGateSyncAttemptCount(event) + 1
  );
  const retryExhausted = nextAttemptCount >= CALENDAR_GATE_SYNC_MAX_ATTEMPTS;
  if (retryExhausted) {
    event.gateTimeSync = {
      status: 'failed',
      provider: String(provider || '').trim().toLowerCase() || null,
      reason: String(reason || '').trim() || 'applyFailed',
      arrivalSource: normalizeCalendarGateSyncArrivalSource(arrivalSource),
      attemptedAt: nowMs,
      attemptCount: nextAttemptCount,
      nextRetryAt: null,
      retryExhausted: true
    };
    return { retryExhausted: true };
  }
  event.gateTimeSync = {
    status: 'pending',
    provider: String(provider || '').trim().toLowerCase() || null,
    reason: String(reason || '').trim() || 'awaitingActualArrival',
    arrivalSource: normalizeCalendarGateSyncArrivalSource(arrivalSource),
    attemptedAt: nowMs,
    attemptCount: nextAttemptCount,
    nextRetryAt: buildCalendarGateSyncNextRetryAt({ nowMs, arrEstimatedMs }),
    retryExhausted: false
  };
  return { retryExhausted: false };
}

function setCalendarGateTimeSyncFailure(event, {
  provider = '',
  reason = 'applyFailed',
  arrivalSource = null,
  attemptCount = null,
  nowMs = Date.now()
} = {}) {
  if (!event || typeof event !== 'object') return;
  const nextAttemptCount = Number.isFinite(attemptCount)
    ? Math.max(0, Math.min(CALENDAR_GATE_SYNC_MAX_ATTEMPTS, Math.trunc(attemptCount)))
    : Math.min(
      CALENDAR_GATE_SYNC_MAX_ATTEMPTS,
      getCalendarGateSyncAttemptCount(event) + 1
    );
  const retryExhausted = nextAttemptCount >= CALENDAR_GATE_SYNC_MAX_ATTEMPTS;
  event.gateTimeSync = {
    status: 'failed',
    provider: String(provider || '').trim().toLowerCase() || null,
    reason: String(reason || '').trim() || 'applyFailed',
    arrivalSource: normalizeCalendarGateSyncArrivalSource(arrivalSource),
    attemptedAt: nowMs,
    attemptCount: nextAttemptCount,
    nextRetryAt: null,
    retryExhausted
  };
}

function setCalendarGateTimeSyncSuccess(event, {
  provider = '',
  arrivalSource = 'actual',
  attemptCount = null,
  nowMs = Date.now()
} = {}) {
  if (!event || typeof event !== 'object') return;
  const nextAttemptCount = Number.isFinite(attemptCount)
    ? Math.max(0, Math.min(CALENDAR_GATE_SYNC_MAX_ATTEMPTS, Math.trunc(attemptCount)))
    : Math.min(
      CALENDAR_GATE_SYNC_MAX_ATTEMPTS,
      getCalendarGateSyncAttemptCount(event) + 1
    );
  event.gateTimeSync = {
    status: 'success',
    provider: String(provider || '').trim().toLowerCase() || null,
    reason: null,
    arrivalSource: normalizeCalendarGateSyncArrivalSource(arrivalSource) || 'actual',
    attemptedAt: nowMs,
    attemptCount: nextAttemptCount,
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

function getTimeZoneOffsetMinutes(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = dtf.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const utcTime = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return (utcTime - date.getTime()) / 60000;
}

function getUtcMsForZonedLocalTime({ year, month, day, minutes }, timeZone) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return NaN;
  if (!Number.isFinite(minutes)) return NaN;
  if (!timeZone) return NaN;
  const totalMinutes = Number(minutes);
  const dayOffset = Math.floor(totalMinutes / 1440);
  const minuteOffset = totalMinutes - (dayOffset * 1440);
  const baseUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0)
    + (dayOffset * 86400000)
    + (minuteOffset * 60000);
  const firstOffset = getTimeZoneOffsetMinutes(timeZone, new Date(baseUtc));
  if (!Number.isFinite(firstOffset)) return NaN;
  const firstUtc = baseUtc - (firstOffset * 60000);
  const secondOffset = getTimeZoneOffsetMinutes(timeZone, new Date(firstUtc));
  if (!Number.isFinite(secondOffset)) return NaN;
  return baseUtc - (secondOffset * 60000);
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
      const flightInfo = extractCalendarFlightIdentifier(event);
      if (!flightInfo) return;
      const { depCode, arrCode } = getCalendarEventBoundaryAirports(event);
      if (!depCode || !arrCode) return;
      const arrivalMs = getCalendarEventArrivalMs(event, normalizedDateKey);
      if (!Number.isFinite(arrivalMs)) return;
      if (!force && !isCalendarGateSyncDue(event, { arrivalMs, nowMs })) return;
      if (arrivalMs < startMs || arrivalMs > endMs) return;
      const arrivalAgeMs = nowMs - arrivalMs;
      const provider = getCalendarGateSyncProviderForArrivalAge(arrivalAgeMs, env);
      if (provider === 'skip') return;
      const flightIcaoCandidates = buildCalendarAirlabsFlightIcaoCandidates(flightInfo.prefix, flightInfo.number);
      if (!flightIcaoCandidates.length) return;
      const dueAt = getCalendarGateSyncDueAt(event, arrivalMs);
      candidates.push({
        event,
        dateKey: normalizedDateKey,
        depCode,
        arrCode,
        arrivalMs,
        arrivalAgeMs,
        dueAt,
        flightIcaoCandidates
      });
    });
  });
  return candidates;
}

function normalizeCalendarGateLocalTime(entry, fallbackDateKey) {
  if (!entry || typeof entry !== 'object') return null;
  const minutes = Number(entry.minutes);
  if (!Number.isFinite(minutes)) return null;
  const normalizedDateKey = normalizeCalendarDateKey(entry.dateKey || fallbackDateKey);
  if (!normalizedDateKey) return null;
  return {
    dateKey: normalizedDateKey,
    minutes: Math.max(0, Math.min(1439, Math.trunc(minutes)))
  };
}

function getCalendarGateLocalMs(localTime, fallbackDateKey, {
  timeZone = '',
  tsSeconds = NaN
} = {}) {
  const tsMs = Number(tsSeconds) * 1000;
  if (Number.isFinite(tsMs)) return tsMs;
  const normalized = normalizeCalendarGateLocalTime(localTime, fallbackDateKey);
  if (!normalized) return NaN;
  const parts = parseDateKeyParts(normalized.dateKey);
  if (!parts) return NaN;
  const zone = String(timeZone || '').trim();
  if (!zone) return NaN;
  return getUtcMsForZonedLocalTime({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    minutes: normalized.minutes
  }, zone);
}

function resolveCalendarGateLocalTime({
  localTime = null,
  tsSeconds = NaN,
  timeZone = '',
  fallbackDateKey = ''
} = {}) {
  const normalizedLocal = normalizeCalendarGateLocalTime(localTime, fallbackDateKey);
  if (normalizedLocal) return normalizedLocal;
  if (!Number.isFinite(tsSeconds)) return null;
  if (!timeZone) return null;
  return getLocalMinutesFromUtc(tsSeconds, timeZone);
}

function applyCalendarGateTimingUpdate(candidate, {
  departureMinutes = NaN,
  arrivalMinutes = NaN,
  source = 'airlabs'
} = {}) {
  if (!candidate?.event) return { updated: false };
  if (!Number.isFinite(departureMinutes) || !Number.isFinite(arrivalMinutes)) return { updated: false };
  const dep = Math.max(0, Math.min(1439, Math.trunc(departureMinutes)));
  const arr = Math.max(0, Math.min(1439, Math.trunc(arrivalMinutes)));
  candidate.event.departureMinutes = dep;
  candidate.event.arrivalMinutes = arr;
  if (Array.isArray(candidate.event?.segments) && candidate.event.segments.length) {
    const firstSeg = candidate.event.segments[0];
    if (firstSeg && typeof firstSeg === 'object') {
      firstSeg.departureMinutes = dep;
    }
    const lastSeg = candidate.event.segments[candidate.event.segments.length - 1];
    if (lastSeg && typeof lastSeg === 'object') {
      lastSeg.arrivalMinutes = arr;
    }
  }
  if (source) candidate.event.timeSource = source;
  const overnightMinutes = arr < dep ? arr + 1440 : arr;
  const localBlockMinutes = Math.max(0, overnightMinutes - dep);
  if (Number.isFinite(localBlockMinutes)) {
    candidate.event.blockMinutes = localBlockMinutes;
    candidate.event.creditMinutes = isDeadheadEvent(candidate.event)
      ? Math.round(localBlockMinutes * 0.5)
      : localBlockMinutes;
  }
  return { updated: true };
}

function applyCalendarGateDepartureOnly(candidate, departureMinutes, source) {
  if (!candidate?.event) return { updated: false };
  const existingArrival = Number(candidate.event.arrivalMinutes);
  if (Number.isFinite(existingArrival)) {
    return applyCalendarGateTimingUpdate(candidate, {
      departureMinutes,
      arrivalMinutes: existingArrival,
      source
    });
  }
  candidate.event.departureMinutes = Math.max(0, Math.min(1439, Math.trunc(departureMinutes)));
  if (Array.isArray(candidate.event?.segments) && candidate.event.segments.length) {
    const firstSeg = candidate.event.segments[0];
    if (firstSeg && typeof firstSeg === 'object') {
      firstSeg.departureMinutes = candidate.event.departureMinutes;
    }
  }
  if (source) candidate.event.timeSource = source;
  return { updated: true };
}

function applyGateTimesToCalendarCandidate(candidate, gateTimes, { source = 'airlabs', nowMs = Date.now() } = {}) {
  if (!candidate) {
    return {
      updated: false,
      pending: false,
      completed: false,
      reason: 'applyFailed',
      arrivalSource: null,
      arrEstimatedMs: NaN
    };
  }
  if (!gateTimes) {
    return {
      updated: false,
      pending: true,
      completed: false,
      reason: 'missingActualTimes',
      arrivalSource: null,
      arrEstimatedMs: NaN
    };
  }
  const depZone = getCachedAirportTimeZone(candidate.depCode);
  const arrZone = getCachedAirportTimeZone(candidate.arrCode);
  const depLocal = resolveCalendarGateLocalTime({
    localTime: gateTimes.local_departure,
    tsSeconds: gateTimes.gate_departure,
    timeZone: depZone,
    fallbackDateKey: candidate.dateKey
  });
  if (!depLocal) {
    if (Number.isFinite(gateTimes.gate_departure) && !depZone) {
      return {
        updated: false,
        pending: true,
        completed: false,
        reason: 'timezoneMissing',
        arrivalSource: null,
        arrEstimatedMs: NaN
      };
    }
    return {
      updated: false,
      pending: true,
      completed: false,
      reason: 'missingActualDeparture',
      arrivalSource: null,
      arrEstimatedMs: NaN
    };
  }
  const depOffset = getDateKeyDayOffset(depLocal.dateKey, candidate.dateKey);
  if (!Number.isFinite(depOffset) || Math.abs(depOffset) > 1) {
    return {
      updated: false,
      pending: true,
      completed: false,
      reason: 'dateMismatch',
      arrivalSource: null,
      arrEstimatedMs: NaN
    };
  }

  const arrActualLocal = resolveCalendarGateLocalTime({
    localTime: gateTimes.local_arrival,
    tsSeconds: gateTimes.gate_arrival,
    timeZone: arrZone,
    fallbackDateKey: depLocal.dateKey
  });
  if (arrActualLocal) {
    const dayOffset = getDateKeyDayOffset(arrActualLocal.dateKey, depLocal.dateKey);
    if (!Number.isFinite(dayOffset) || dayOffset < 0 || dayOffset > 1) {
      return {
        updated: false,
        pending: true,
        completed: false,
        reason: 'dateMismatch',
        arrivalSource: null,
        arrEstimatedMs: NaN
      };
    }
    const result = applyCalendarGateTimingUpdate(candidate, {
      departureMinutes: depLocal.minutes,
      arrivalMinutes: arrActualLocal.minutes,
      source
    });
    if (!result?.updated) {
      return {
        updated: false,
        pending: true,
        completed: false,
        reason: 'applyFailed',
        arrivalSource: null,
        arrEstimatedMs: NaN
      };
    }
    return {
      updated: true,
      pending: false,
      completed: true,
      reason: null,
      arrivalSource: 'actual',
      arrEstimatedMs: NaN
    };
  }

  const arrEstimatedLocal = resolveCalendarGateLocalTime({
    localTime: gateTimes.local_arrival_estimated,
    tsSeconds: gateTimes.gate_arrival_estimated,
    timeZone: arrZone,
    fallbackDateKey: depLocal.dateKey
  });
  if (arrEstimatedLocal) {
    const dayOffset = getDateKeyDayOffset(arrEstimatedLocal.dateKey, depLocal.dateKey);
    if (!Number.isFinite(dayOffset) || dayOffset < 0 || dayOffset > 1) {
      return {
        updated: false,
        pending: true,
        completed: false,
        reason: 'dateMismatch',
        arrivalSource: 'estimated',
        arrEstimatedMs: NaN
      };
    }
    const result = applyCalendarGateTimingUpdate(candidate, {
      departureMinutes: depLocal.minutes,
      arrivalMinutes: arrEstimatedLocal.minutes,
      source
    });
    if (!result?.updated) {
      return {
        updated: false,
        pending: true,
        completed: false,
        reason: 'applyFailed',
        arrivalSource: 'estimated',
        arrEstimatedMs: NaN
      };
    }
    return {
      updated: true,
      pending: true,
      completed: false,
      reason: 'awaitingActualArrival',
      arrivalSource: 'estimated',
      arrEstimatedMs: getCalendarGateLocalMs(arrEstimatedLocal, depLocal.dateKey, {
        timeZone: arrZone,
        tsSeconds: gateTimes.gate_arrival_estimated
      })
    };
  }

  const depOnlyResult = applyCalendarGateDepartureOnly(candidate, depLocal.minutes, source);
  if (!depOnlyResult?.updated) {
    return {
      updated: false,
      pending: true,
      completed: false,
      reason: 'applyFailed',
      arrivalSource: null,
      arrEstimatedMs: NaN
    };
  }
  return {
    updated: true,
    pending: true,
    completed: false,
    reason: 'awaitingActualArrival',
    arrivalSource: null,
    arrEstimatedMs: NaN
  };
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
    return { mutated: false, updatedCount: 0, pendingCount: 0, failedCount: 0 };
  }

  await loadAirportTimezones();

  let mutated = false;
  let updatedCount = 0;
  let pendingCount = 0;
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
      let failureReason = 'noAirlabsMatch';
      if (lookupErrorCount > 0) {
        failureReason = 'lookupError';
      } else if (!noDataCount) {
        failureReason = 'applyFailed';
      }
      const pendingState = setCalendarGateTimeSyncPending(candidate.event, {
        provider: 'airlabs',
        reason: failureReason,
        nowMs: Date.now()
      });
      if (pendingState?.retryExhausted) {
        failedCount += 1;
      } else {
        pendingCount += 1;
      }
      mutated = true;
      continue;
    }

    const outcome = applyGateTimesToCalendarCandidate(candidate, gateTimes, {
      source: 'airlabs',
      nowMs: Date.now()
    });
    if (outcome?.completed && outcome?.updated) {
      setCalendarGateTimeSyncSuccess(candidate.event, {
        provider: 'airlabs',
        arrivalSource: 'actual',
        nowMs: Date.now()
      });
      updatedCount += 1;
    } else if (outcome?.pending) {
      const pendingState = setCalendarGateTimeSyncPending(candidate.event, {
        provider: 'airlabs',
        reason: outcome?.reason || 'awaitingActualArrival',
        arrivalSource: outcome?.arrivalSource || null,
        arrEstimatedMs: outcome?.arrEstimatedMs,
        nowMs: Date.now()
      });
      if (outcome?.updated) {
        updatedCount += 1;
      }
      if (pendingState?.retryExhausted) {
        failedCount += 1;
      } else {
        pendingCount += 1;
      }
    } else if (outcome?.updated) {
      setCalendarGateTimeSyncSuccess(candidate.event, {
        provider: 'airlabs',
        arrivalSource: 'actual',
        nowMs: Date.now()
      });
      updatedCount += 1;
    } else {
      setCalendarGateTimeSyncFailure(candidate.event, {
        provider: 'airlabs',
        reason: outcome?.reason || 'applyFailed',
        arrivalSource: outcome?.arrivalSource || null,
        nowMs: Date.now()
      });
      failedCount += 1;
    }
    mutated = true;
  }

  if (mutated) {
    record.months = buildCalendarMonths(record.eventsByDate);
  }

  return { mutated, updatedCount, pendingCount, failedCount };
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
      : (err?.code === 'invalidFlight'
        ? 400
        : (err?.code === 'noFlightData' ? 404 : 502));
    return jsonResponse(
      { error: err?.message || `Unable to reach AirLabs: ${err}` },
      { status, headers: withCors({}, origin) }
    );
  }
}

async function runScheduledGateSync(env, scheduledTime) {
  if (!env.AC_PAY_CALENDAR) {
    console.warn('Calendar storage not configured; skipping scheduled gate sync.');
    return { mutated: false, updatedCount: 0, pendingCount: 0, failedCount: 0, skipped: 'missingStorage' };
  }
  if (!String(env.AIRLABS_API_KEY || '').trim()) {
    console.warn('AIRLABS_API_KEY missing; skipping scheduled gate sync.');
    return { mutated: false, updatedCount: 0, pendingCount: 0, failedCount: 0, skipped: 'missingAirlabsKey' };
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
    ctx.waitUntil((async () => {
      try {
        const result = await runScheduledGateSync(env, scheduledTime);
        console.log('Scheduled gate sync complete', {
          updatedCount: result.updatedCount || 0,
          pendingCount: result.pendingCount || 0,
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
