const CALENDAR_KEY = 'calendar:default';

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
  if (origin) {
    next.set('Access-Control-Allow-Origin', origin);
    next.set('Vary', 'Origin');
  }
  next.set('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  next.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-None-Match');
  next.set('Access-Control-Expose-Headers', 'ETag');
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
  const allowedKeys = [...requiredKeys];
  const keys = Object.keys(payload);
  const missing = requiredKeys.filter(key => !(key in payload));
  if (missing.length) {
    return { ok: false, message: `Missing keys: ${missing.join(', ')}` };
  }
  const extra = keys.filter(key => !allowedKeys.includes(key));
  if (extra.length) {
    return { ok: false, message: `Unexpected keys: ${extra.join(', ')}` };
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
    updatedAt: null,
    etag: null
  };
  const payload = stored
    ? {
      ...defaultPayload,
      ...stored,
      blockMonthsByMonthKey: stored.blockMonthsByMonthKey || {},
      blockMonthRecurring: stored.blockMonthRecurring || {}
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
  const etag = await computeEtag({
    eventsByDate: payload.eventsByDate,
    months: payload.months,
    selectedMonth: payload.selectedMonth,
    blockMonthsByMonthKey,
    blockMonthRecurring
  });
  const record = {
    eventsByDate: payload.eventsByDate,
    months: payload.months,
    selectedMonth: payload.selectedMonth,
    blockMonthsByMonthKey,
    blockMonthRecurring,
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
