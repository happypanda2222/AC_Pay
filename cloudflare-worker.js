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
  const allowedKeys = ['eventsByDate', 'months', 'selectedMonth'];
  const keys = Object.keys(payload);
  const missing = allowedKeys.filter(key => !(key in payload));
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
    updatedAt: null,
    etag: null
  };
  const payload = stored || defaultPayload;
  const headers = withCors({ ETag: payload.etag || '' }, origin);
  return jsonResponse(
    {
      eventsByDate: payload.eventsByDate,
      months: payload.months,
      selectedMonth: payload.selectedMonth,
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
    return jsonResponse({ error: validation.message }, { status: 400, headers: withCors({}, origin) });
  }
  const updatedAt = new Date().toISOString();
  const etag = await computeEtag(payload);
  const record = {
    eventsByDate: payload.eventsByDate,
    months: payload.months,
    selectedMonth: payload.selectedMonth,
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
    const origin = configuredOrigin
      ? (requestOrigin === configuredOrigin ? configuredOrigin : '')
      : requestOrigin;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCors({}, origin) });
    }

    if (!url.pathname.startsWith('/sync/calendar')) {
      return new Response('Not found', { status: 404, headers: withCors({}, origin) });
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
