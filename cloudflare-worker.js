const CALENDAR_KEY = 'calendar:default';
const CALENDAR_SCHEMA_VERSION = 3;

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

async function handleGet(env, origin) {
  const stored = await env.AC_PAY_CALENDAR.get(CALENDAR_KEY, 'json');
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
  const payload = stored
    ? {
      ...defaultPayload,
      ...stored,
      blockMonthsByMonthKey: stored.blockMonthsByMonthKey || {},
      blockMonthRecurring: stored.blockMonthRecurring || {},
      hotels: Array.isArray(stored.hotels) ? stored.hotels : []
    }
    : defaultPayload;
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

    if (url.pathname.startsWith('/aeroapi/')) {
      if (!isAuthorized(request, env)) {
        return jsonResponse({ error: 'Unauthorized.' }, { status: 401, headers: withCors({}, origin) });
      }
      if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405, headers: withCors({}, origin) });
      }
      const upstreamPath = url.pathname.replace(/^\/aeroapi\/?/, '');
      const upstreamUrl = new URL(upstreamPath, 'https://aeroapi.flightaware.com/aeroapi/');
      upstreamUrl.search = url.search;
      const upstreamHeaders = new Headers();
      const xApiKey = request.headers.get('x-apikey') || request.headers.get('x-api-key');
      if (xApiKey) upstreamHeaders.set('x-apikey', xApiKey);
      const accept = request.headers.get('accept');
      if (accept) upstreamHeaders.set('accept', accept);
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
  }
};
