/*
 * Enhanced AC Pay Calculator logic with support for 2026 tax data, a Monthly
 * calculation with pay advance/second pay split, tax return calculation and
 * optional CPP/EI caps in the monthly view.  This file is based on the original app.js from
 * the AC Pay repository but has been significantly extended to meet
 * additional requirements.  The key enhancements are:
 *
 *   - 2026 federal and provincial tax tables with automatic selection
 *     based on the chosen year.
 *   - A monthly calculation that accepts credit hours, VO credits and
 *     TAFB hours and applies double‑time pay rules.
 *   - A pay advance/second pay split in the monthly view to separate tax
 *     and CPP/QPP/EI withholding across two cheques.
 *   - A Maxed CPP/EI checkbox for the monthly view that removes CPP/QPP and
 *     EI deductions from both pay advance and second pay calculations while
 *     leaving the monthly net unchanged.  Annual results always use the
 *     full CPP/QPP and EI contributions.
 *   - RRSP contributions are no longer deducted from net pay.  Instead
 *     they are used solely to compute a Tax Return value equal to the
 *     difference between tax calculated before and after RRSP.  This
 *     Tax Return appears only in the annual results.  The RRSP input
 *     remains in the UI but now only influences the Tax Return figure.
 */

'use strict';

// --- Version badge synced with sw.js CACHE version ---
async function updateVersionBadgeFromSW() {
  const badge = document.getElementById('version');
  if (!badge) return;
  try {
    const resp = await fetch('./sw.js', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const match = text.match(/const\s+CACHE\s*=\s*'([^']+)'/);
    if (match && match[1]) {
      const version = match[1];
      badge.textContent = version;
      badge.setAttribute('title', `App version ${version}`);
      badge.setAttribute('aria-label', `App version ${version}`);
    }
  } catch (err) {
    console.error('Version badge update failed', err);
  }
}

// --- Lock zoom: block pinch & double-tap zoom (best-effort for iOS PWAs) ---
(function preventZoom(){
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  // Pinch-zoom gestures (iOS Safari exposes these)
  document.addEventListener('gesturestart', stop, {passive:false});
  document.addEventListener('gesturechange', stop, {passive:false});
  document.addEventListener('gestureend', stop, {passive:false});
  // Double-tap zoom
  let lastTouch = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    const target = e.target instanceof Element ? e.target : e.target?.parentElement;
    const isInteractive = target instanceof Element
      && target.closest('button, a, input, select, textarea, [role="button"], [role="tab"]');
    if (!isInteractive){
      if (now - lastTouch < 300) { e.preventDefault(); }
      lastTouch = now;
    }
  }, {passive:false});
})();

// --- Constants & Config ---
const DOH = new Date('2024-08-07T00:00:00Z');
const PROGRESSION = {m:11, d:5};
const SWITCH = {m:9, d:30};
const AIRCRAFT_ORDER = ["777","787","330","767","320","737","220"];
const HEALTH_MO = 58.80;
const DIVIDEND_GROSS_UP = { eligible: 1.38, nonEligible: 1.15 };
const CAPITAL_GAINS_INCLUSION = 0.5;
const FIN_CUSTOM_STORAGE_KEY = 'acpay.fin.custom';
const FIN_EXPORT_SETTINGS_KEY = 'acpay.fin.export.settings';
const LEGACY_FIN_SYNC_SETTINGS_KEY = 'acpay.fin.sync.settings';
const CORS_PROXY = 'https://cors.isomorphic-git.org/';
function normalizeProxyTarget(url){
  const safeUrl = String(url || '').trim();
  if (!safeUrl) return '';
  return safeUrl.startsWith('http') ? safeUrl : `https://${safeUrl}`;
}
const CORS_PROXY_FALLBACKS = [
  { label: 'direct', build: (url) => normalizeProxyTarget(url), allowsAuth: true },
  { label: 'corsproxy.io', build: (url) => {
    const safeUrl = normalizeProxyTarget(url);
    return safeUrl.startsWith('https://corsproxy.io/?') ? safeUrl : `https://corsproxy.io/?${safeUrl}`;
  }, allowsAuth: true },
  { label: 'isomorphic', build: (url) => {
    const safeUrl = normalizeProxyTarget(url);
    return safeUrl.startsWith(CORS_PROXY) ? safeUrl : `${CORS_PROXY}${safeUrl}`;
  }, allowsAuth: true },
  { label: 'allorigins', build: (url) => {
    const safeUrl = normalizeProxyTarget(url);
    return safeUrl ? `https://api.allorigins.win/raw?url=${encodeURIComponent(safeUrl)}` : '';
  }, allowsAuth: true }
];
const FR24_SUMMARY_LOOKBACK_HOURS = 72;
const FLIGHTRADAR24_CONFIG_KEY = 'acpay.fr24.config';
const FLIGHTRADAR24_DEFAULT_BASE = 'https://fr24api.flightradar24.com/api';
const FLIGHTRADAR24_DEFAULT_VERSION = 'v1';
const FLIGHTRADAR24_PUBLIC_BASE = 'https://api.flightradar24.com';
const FIN_FLIGHT_CACHE = new Map();
const FIN_LIVE_POSITION_CACHE = new Map();
const CALENDAR_STORAGE_KEY = 'acpay.calendar.schedule';
const CALENDAR_PREFS_KEY = 'acpay.calendar.prefs';
const CALENDAR_WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
let finAirportCodeMode = 'iata';
const finHiddenContext = { page: null, fin: null, registration: '' };
let flightLookupCarrier = 'ACA';

function normalizeFr24Headers(value){
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = {};
  Object.entries(value).forEach(([key, val]) => {
    if (typeof key !== 'string') return;
    if (['string', 'number', 'boolean'].includes(typeof val)){
      clean[key] = String(val);
    }
  });
  return clean;
}

function normalizeFr24BaseUrl(value){
  const base = String(value ?? '').trim();
  return base || FLIGHTRADAR24_DEFAULT_BASE;
}

function isOfficialFr24Base(baseUrl){
  return String(baseUrl || '').toLowerCase().includes('fr24api.flightradar24.com');
}

function expandFinConfig(config){
  if (!config) return [];
  const start = Number(config.finStart);
  const end = Number.isFinite(config.finEnd) ? Number(config.finEnd) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const finStart = Math.min(start, end);
  const finEnd = Math.max(start, end);
  const entries = [];
  for (let fin = finStart; fin <= finEnd; fin += 1){
    entries.push({ ...config, finStart: fin, finEnd: fin });
  }
  return entries;
}

function expandFinConfigList(list){
  if (!Array.isArray(list)) return [];
  return list.flatMap(expandFinConfig);
}

function normalizeRegistration(reg){
  return String(reg ?? '').trim().toUpperCase();
}
function normalizeCallsign(value){
  return String(value ?? '').trim().toUpperCase();
}

function cloneFetchOptions(options){
  if (!options) return {};
  const cloned = { ...options };
  if (options.headers instanceof Headers){
    cloned.headers = new Headers(options.headers);
  } else if (options.headers && typeof options.headers === 'object'){
    cloned.headers = { ...options.headers };
  }
  return cloned;
}

async function fetchWithCorsFallback(url, options = {}){
  const trimmedUrl = normalizeProxyTarget(url);
  if (!trimmedUrl) throw new Error('Missing URL for live data request.');
  const headers = options?.headers;
  const headerEntries = headers instanceof Headers
    ? Array.from(headers.entries())
    : (headers && typeof headers === 'object' ? Object.entries(headers) : []);
  const hasAuthHeader = headerEntries.some(([key]) => ['authorization', 'x-api-key'].includes(String(key || '').toLowerCase()));
  const attempts = [];
  const seen = new Set();
  let lastError = null;
  const proxies = CORS_PROXY_FALLBACKS
    .filter((proxy) => !hasAuthHeader || proxy.allowsAuth)
    .sort((a, b) => {
      // For FlightRadar24 calls in the browser, prioritize CORS-friendly proxies before direct
      // to avoid the 200-with-CORS-blocked pattern seen on the official API host.
      const order = ['isomorphic', 'corsproxy.io', 'allorigins', 'direct'];
      try {
        const host = new URL(trimmedUrl).hostname || '';
        if (host.includes('flightradar24.com')){
          return order.indexOf(a.label) - order.indexOf(b.label);
        }
      } catch (_err){ /* noop */ }
      return 0;
    });
  for (const proxy of proxies){
    const target = proxy.build(trimmedUrl);
    if (!target || seen.has(target)) continue;
    seen.add(target);
    try {
      const resp = await fetch(target, cloneFetchOptions(options));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp;
    } catch (err){
      attempts.push(`${proxy.label}: ${err?.message || err}`);
      lastError = err;
    }
  }
  if (attempts.length){
    console.warn('Live data request failed across all proxies', { url: trimmedUrl, attempts, lastError });
  }
  const attemptLabels = attempts.map(entry => entry.split(':')[0]).filter(Boolean);
  const friendly = attempts.length
    ? `Live data temporarily unavailable. Tried ${Array.from(new Set(attemptLabels)).join(', ')}.`
    : 'Live data temporarily unavailable. Please try again later.';
  const error = new Error(friendly);
  if (attempts.length) error.attempts = attempts;
  if (lastError) error.cause = lastError;
  throw error;
}

function getFr24ApiConfig(){
  try {
    const stored = JSON.parse(localStorage.getItem(FLIGHTRADAR24_CONFIG_KEY) || '{}');
    return {
      baseUrl: normalizeFr24BaseUrl(stored.baseUrl),
      apiToken: typeof stored.apiToken === 'string' ? stored.apiToken.trim() : '',
      apiVersion: typeof stored.apiVersion === 'string' && stored.apiVersion.trim()
        ? stored.apiVersion.trim()
        : FLIGHTRADAR24_DEFAULT_VERSION,
      headers: normalizeFr24Headers(stored.headers)
    };
  } catch (err){
    console.warn('Invalid FlightRadar24 config; falling back to defaults.', err);
    return {
      baseUrl: FLIGHTRADAR24_DEFAULT_BASE,
      apiToken: '',
      apiVersion: FLIGHTRADAR24_DEFAULT_VERSION,
      headers: {}
    };
  }
}

function saveFr24ApiConfig(partial){
  try {
    const current = getFr24ApiConfig();
    const merged = {
      ...current,
      ...partial,
      headers: partial.headers !== undefined ? normalizeFr24Headers(partial.headers) : current.headers
    };
    merged.baseUrl = normalizeFr24BaseUrl(merged.baseUrl);
    merged.apiVersion = (merged.apiVersion || FLIGHTRADAR24_DEFAULT_VERSION).trim() || FLIGHTRADAR24_DEFAULT_VERSION;
    merged.apiToken = (merged.apiToken || '').trim();
    localStorage.setItem(FLIGHTRADAR24_CONFIG_KEY, JSON.stringify(merged));
    return merged;
  } catch (err){
    console.warn('Failed to save FlightRadar24 config', err);
    return getFr24ApiConfig();
  }
}

function buildFr24Headers(){
  const config = getFr24ApiConfig();
  const userHeaders = normalizeFr24Headers(config.headers);
  const headers = { Accept: 'application/json', ...userHeaders };
  const apiVersionHeader = config.apiVersion || FLIGHTRADAR24_DEFAULT_VERSION;
  const setIfMissing = (name, value) => {
    if (!value) return;
    const exists = Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
    if (!exists){
      headers[name] = value;
    }
  };
  setIfMissing('Authorization', config.apiToken ? `Bearer ${config.apiToken}` : null);
  setIfMissing('Accept-Version', apiVersionHeader);
  setIfMissing('API-Version', apiVersionHeader);
  return headers;
}

function buildFr24Url(path, params = {}){
  const { baseUrl } = getFr24ApiConfig();
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== ''){
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function extractFr24DataRows(payload){
  const candidates = [
    payload,
    payload?.data,
    payload?.result,
    payload?.response,
    payload?.result?.response,
    payload?.response?.result,
    payload?.data?.result,
    payload?.data?.response
  ];
  for (const candidate of candidates){
    if (!candidate || typeof candidate !== 'object') continue;
    if (Array.isArray(candidate)) return candidate;
    if (Array.isArray(candidate.data)) return candidate.data;
    if (candidate.data && typeof candidate.data === 'object' && !Array.isArray(candidate.data)){
      const values = Object.values(candidate.data).filter((item) => item !== undefined && item !== null);
      if (values.length) return values;
    }
  }
  return [];
}

function normalizeFr24Timestamp(ts){
  const num = Number(ts);
  if (!Number.isFinite(num)) return null;
  return num > 1e12 ? Math.round(num / 1000) : Math.round(num);
}

function formatFr24DateTimeUtc(date){
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function parseFr24Date(value){
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
  return normalizeFr24Timestamp(value);
}

function deriveFr24FlightStatus(entry, departureTime, arrivalTime){
  if (!entry) return 'planned';
  if (entry.flight_ended === false) return 'active';
  if (entry.flight_ended === true) return 'completed';
  const statusText = String(entry.status ?? entry.flight_status ?? entry.flightstatus ?? '').toLowerCase();
  const compactStatus = statusText.replace(/[\s_-]+/g, '');
  if (['active', 'enroute', 'inair', 'inflight'].some((needle) => compactStatus.includes(needle))) return 'active';
  if (statusText.includes('landed') || statusText.includes('arrived')) return 'completed';
  if (Number.isFinite(departureTime) && !Number.isFinite(arrivalTime)) return 'active';
  if (Number.isFinite(departureTime) && Number.isFinite(arrivalTime)) return 'completed';
  return 'planned';
}

function populateFr24ConfigForm(){
  const config = getFr24ApiConfig();
  const baseInput = document.getElementById('fr24-base-url');
  const tokenInput = document.getElementById('fr24-token');
  const versionInput = document.getElementById('fr24-version');
  const extraHeadersInput = document.getElementById('fr24-extra-headers');
  const statusEl = document.getElementById('fr24-status');
  if (baseInput) baseInput.value = config.baseUrl || FLIGHTRADAR24_DEFAULT_BASE;
  if (tokenInput) tokenInput.value = config.apiToken || '';
  if (versionInput) versionInput.value = config.apiVersion || FLIGHTRADAR24_DEFAULT_VERSION;
  if (extraHeadersInput){
    const headers = normalizeFr24Headers(config.headers);
    extraHeadersInput.value = Object.keys(headers).length ? JSON.stringify(headers, null, 2) : '';
  }
  if (statusEl){
    statusEl.textContent = 'Settings are saved locally and used for live fin tracking.';
  }
}

function handleFr24ConfigSave(){
  const statusEl = document.getElementById('fr24-status');
  const baseInput = document.getElementById('fr24-base-url');
  const tokenInput = document.getElementById('fr24-token');
  const versionInput = document.getElementById('fr24-version');
  const extraHeadersInput = document.getElementById('fr24-extra-headers');
  let extraHeaders = {};
  if (extraHeadersInput && extraHeadersInput.value.trim()){
    try {
      const parsed = JSON.parse(extraHeadersInput.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)){
        throw new Error('Extra headers must be a JSON object.');
      }
      extraHeaders = parsed;
    } catch (err){
      if (statusEl){
        statusEl.textContent = `Save failed: ${err.message}`;
      }
      return;
    }
  }
  const saved = saveFr24ApiConfig({
    baseUrl: baseInput?.value ?? FLIGHTRADAR24_DEFAULT_BASE,
    apiToken: tokenInput?.value?.trim() ?? '',
    apiVersion: versionInput?.value?.trim() || FLIGHTRADAR24_DEFAULT_VERSION,
    headers: extraHeaders
  });
  if (statusEl){
    const authSummary = saved.apiToken ? 'Bearer token' : 'no credentials';
    statusEl.textContent = `Saved. Using ${saved.baseUrl} with ${authSummary}.`;
  }
}


const FIN_CONFIGS = expandFinConfigList([
  { type: 'A220', finStart: 101, finEnd: 101, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GROV' },
  { type: 'A220', finStart: 102, finEnd: 102, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GJXE' },
  { type: 'A220', finStart: 103, finEnd: 103, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GJXN' },
  { type: 'A220', finStart: 104, finEnd: 104, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GJXV' },
  { type: 'A220', finStart: 105, finEnd: 105, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GJXW' },
  { type: 'A220', finStart: 106, finEnd: 106, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GJXY' },
  { type: 'A220', finStart: 107, finEnd: 107, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GJYA' },
  { type: 'A220', finStart: 108, finEnd: 108, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GJYC' },
  { type: 'A220', finStart: 109, finEnd: 109, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GJYE' },
  { type: 'A220', finStart: 110, finEnd: 110, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GJYI' },
  { type: 'A220', finStart: 111, finEnd: 111, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GMYU' },
  { type: 'A220', finStart: 112, finEnd: 112, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GMZN' },
  { type: 'A220', finStart: 113, finEnd: 113, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GMZR' },
  { type: 'A220', finStart: 114, finEnd: 114, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GMZY' },
  { type: 'A220', finStart: 115, finEnd: 115, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GNGV' },
  { type: 'A220', finStart: 116, finEnd: 116, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GNAM' },
  { type: 'A220', finStart: 117, finEnd: 117, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GTZH' },
  { type: 'A220', finStart: 118, finEnd: 118, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GNBE' },
  { type: 'A220', finStart: 119, finEnd: 119, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GNBN' },
  { type: 'A220', finStart: 120, finEnd: 120, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GTZS' },
  { type: 'A220', finStart: 121, finEnd: 121, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GTZU' },
  { type: 'A220', finStart: 122, finEnd: 122, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GUAC' },
  { type: 'A220', finStart: 123, finEnd: 123, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GUPG' },
  { type: 'A220', finStart: 124, finEnd: 124, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GUPK' },
  { type: 'A220', finStart: 125, finEnd: 125, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GUPL' },
  { type: 'A220', finStart: 126, finEnd: 126, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GVDP' },
  { type: 'A220', finStart: 127, finEnd: 127, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GVDQ' },
  { type: 'A220', finStart: 128, finEnd: 128, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GVUH' },
  { type: 'A220', finStart: 129, finEnd: 129, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GVUN' },
  { type: 'A220', finStart: 130, finEnd: 130, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GVUO' },
  { type: 'A220', finStart: 131, finEnd: 131, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GWUQ' },
  { type: 'A220', finStart: 132, finEnd: 132, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GWUS' },
  { type: 'A220', finStart: 133, finEnd: 133, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GWUT' },
  { type: 'A220', finStart: 134, finEnd: 134, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-FDUW' },
  { type: 'A220', finStart: 135, finEnd: 135, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-FDUY' },
  { type: 'A220', finStart: 136, finEnd: 136, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GYLQ' },
  { type: 'A220', finStart: 137, finEnd: 137, j: 12, o: 0, y: 125, fdjs: 1, ofcr: 0, ccjs: 3, reg: 'C-GYLY' },
  { type: 'A320 Jetz', finStart: 225, finEnd: 225, j: 70, o: 0, y: 0, fdjs: 1, ofcr: 0, ccjs: 5 },
  { type: 'A320 Jetz', finStart: 226, finEnd: 226, j: 70, o: 0, y: 0, fdjs: 1, ofcr: 0, ccjs: 5 },
  { type: 'A320 Jetz', finStart: 232, finEnd: 232, j: 70, o: 0, y: 0, fdjs: 1, ofcr: 0, ccjs: 5 },
  { type: 'A320', finStart: 235, finEnd: 235, j: 14, o: 0, y: 132, fdjs: 1, ofcr: 0, ccjs: 5, reg: 'C-GJVT' },
  { type: 'A320', finStart: 236, finEnd: 236, j: 14, o: 0, y: 132, fdjs: 1, ofcr: 0, ccjs: 5, reg: 'C-GKOD' },
  { type: 'A320', finStart: 237, finEnd: 237, j: 14, o: 0, y: 132, fdjs: 1, ofcr: 0, ccjs: 5, reg: 'C-GKOE' },
  { type: 'A320', finStart: 238, finEnd: 238, j: 14, o: 0, y: 132, fdjs: 1, ofcr: 0, ccjs: 5, reg: 'C-FZUB' },
  { type: 'A320', finStart: 239, finEnd: 239, j: 14, o: 0, y: 132, fdjs: 1, ofcr: 0, ccjs: 5, reg: 'C-FXCD' },
  { type: 'A320', finStart: 240, finEnd: 240, j: 14, o: 0, y: 132, fdjs: 1, ofcr: 0, ccjs: 5, reg: 'C-FZQS' },
  { type: 'A320', finStart: 241, finEnd: 241, j: 14, o: 0, y: 132, fdjs: 2, ofcr: 0, ccjs: 6, reg: 'C-FGJI' },
  { type: 'A320', finStart: 242, finEnd: 242, j: 14, o: 0, y: 132, fdjs: 2, ofcr: 0, ccjs: 6, reg: 'C-FGKH' },
  { type: 'A320 Rouge', finStart: 243, finEnd: 243, j: 12, o: 0, y: 156, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GFCH' },
  { type: 'A320 Rouge', finStart: 244, finEnd: 244, j: 12, o: 0, y: 156, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GFCI' },
  { type: 'A320 Rouge', finStart: 245, finEnd: 245, j: 12, o: 0, y: 156, fdjs: 2, ofcr: 0, ccjs: 4, reg: 'C-GFCP' },
  { type: 'A320 Rouge', finStart: 246, finEnd: 246, j: 12, o: 0, y: 156, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GFDU' },
  { type: 'A320 Rouge', finStart: 247, finEnd: 247, j: 12, o: 0, y: 156, fdjs: 2, ofcr: 0, ccjs: 4, reg: 'C-GFWX' },
  { type: 'A319', finStart: 251, finEnd: 251, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4 },
  { type: 'A319', finStart: 252, finEnd: 252, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4 },
  { type: 'A319 Rouge', finStart: 255, finEnd: 255, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FYJE' },
  { type: 'A319 Rouge', finStart: 256, finEnd: 256, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FYJG' },
  { type: 'A319 Rouge', finStart: 257, finEnd: 257, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FYJH' },
  { type: 'A319', finStart: 258, finEnd: 258, j: 14, o: 0, y: 120, fdjs: 1, ofcr: 0, ccjs: 4 },
  { type: 'A319 Rouge', finStart: 259, finEnd: 259, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FYJP' },
  { type: 'A319', finStart: 260, finEnd: 260, j: 14, o: 0, y: 120, fdjs: 1, ofcr: 0, ccjs: 4 },
  { type: 'A319 Rouge', finStart: 262, finEnd: 262, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FYKW' },
  { type: 'A319 Rouge', finStart: 263, finEnd: 263, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FZUG' },
  { type: 'A319 Rouge', finStart: 272, finEnd: 272, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GARJ' },
  { type: 'A319 Rouge', finStart: 273, finEnd: 273, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GARO' },
  { type: 'A319 Rouge', finStart: 276, finEnd: 276, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GBHO' },
  { type: 'A319 Rouge', finStart: 277, finEnd: 277, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4 },
  { type: 'A319 Rouge', finStart: 278, finEnd: 278, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GBHY' },
  { type: 'A319 Rouge', finStart: 279, finEnd: 279, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GBHZ' },
  { type: 'A319', finStart: 280, finEnd: 280, j: 14, o: 0, y: 106, fdjs: 1, ofcr: 0, ccjs: 4 },
  { type: 'A319 Rouge', finStart: 281, finEnd: 281, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GBIJ' },
  { type: 'A319 Rouge', finStart: 283, finEnd: 283, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GBIM' },
  { type: 'A319 Rouge', finStart: 284, finEnd: 284, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GBIN' },
  { type: 'A319 Rouge', finStart: 286, finEnd: 286, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GITP' },
  { type: 'A319 Rouge', finStart: 287, finEnd: 287, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GITR' },
  { type: 'A319 Rouge', finStart: 290, finEnd: 290, j: 12, o: 0, y: 124, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GSJB' },
  { type: 'A320', finStart: 401, finEnd: 401, j: 14, o: 0, y: 132, fdjs: 2, ofcr: 0, ccjs: 6 },
  { type: 'A320', finStart: 402, finEnd: 402, j: 14, o: 0, y: 132, fdjs: 2, ofcr: 0, ccjs: 6, reg: 'C-FPWE' },
  { type: 'A320', finStart: 405, finEnd: 405, j: 14, o: 0, y: 132, fdjs: 2, ofcr: 0, ccjs: 6, reg: 'C-FDCA' },
  { type: 'A320', finStart: 415, finEnd: 415, j: 14, o: 0, y: 132, fdjs: 2, ofcr: 0, ccjs: 6 },
  { type: 'A320 Jetz', finStart: 416, finEnd: 416, j: 70, o: 0, y: 0, fdjs: 2, ofcr: 0, ccjs: 6 },
  { type: 'A320', finStart: 417, finEnd: 417, j: 12, o: 0, y: 138, fdjs: 2, ofcr: 0, ccjs: 4, notes: 'Cabin Jumps edited from 6, confirm.', reg: 'C-FCQD' },
  { type: 'A320', finStart: 418, finEnd: 418, j: 12, o: 0, y: 138, fdjs: 2, ofcr: 0, ccjs: 6, reg: 'C-FCQX' },
  { type: 'A320', finStart: 419, finEnd: 419, j: 12, o: 0, y: 138, fdjs: 2, ofcr: 0, ccjs: 6, reg: 'C-FCYX' },
  { type: 'A320', finStart: 420, finEnd: 420, j: 12, o: 0, y: 138, fdjs: 2, ofcr: 0, ccjs: 4, notes: 'Cabin jumps edited from 6, confirm.', reg: 'C-FCZF' },
  { type: 'A320', finStart: 421, finEnd: 421, j: 8, o: 0, y: 150, fdjs: 2, ofcr: 0, ccjs: 6, reg: 'C-FCUG' },
  { type: 'A320', finStart: 422, finEnd: 422, j: 8, o: 0, y: 150, fdjs: 2, ofcr: 0, ccjs: 6, reg: 'C-FDGQ' },
  { type: 'A321', finStart: 451, finEnd: 451, j: 16, o: 0, y: 180, fdjs: 1, ofcr: 0, ccjs: 6, reg: 'C-GITU' },
  { type: 'A321', finStart: 452, finEnd: 452, j: 16, o: 0, y: 174, fdjs: 1, ofcr: 0, ccjs: 6, reg: 'C-GITY' },
  { type: 'A321', finStart: 453, finEnd: 453, j: 16, o: 0, y: 180, fdjs: 1, ofcr: 0, ccjs: 6, reg: 'C-GIUB' },
  { type: 'A321', finStart: 454, finEnd: 454, j: 16, o: 0, y: 180, fdjs: 1, ofcr: 0, ccjs: 6, reg: 'C-GIUE' },
  { type: 'A321', finStart: 455, finEnd: 455, j: 16, o: 0, y: 174, fdjs: 1, ofcr: 0, ccjs: 6, reg: 'C-GIUF' },
  { type: 'A321', finStart: 456, finEnd: 456, j: 16, o: 0, y: 180, fdjs: 1, ofcr: 0, ccjs: 6, reg: 'C-GJVX' },
  { type: 'A321', finStart: 457, finEnd: 457, j: 16, o: 0, y: 180, fdjs: 1, ofcr: 0, ccjs: 6, reg: 'C-GJWD' },
  { type: 'A321', finStart: 458, finEnd: 458, j: 16, o: 0, y: 174, fdjs: 1, ofcr: 0, ccjs: 6, reg: 'C-GJWI' },
  { type: 'A321', finStart: 459, finEnd: 459, j: 16, o: 0, y: 180, fdjs: 1, ofcr: 0, ccjs: 6, reg: 'C-GJWN' },
  { type: 'A321', finStart: 460, finEnd: 460, j: 16, o: 0, y: 180, fdjs: 1, ofcr: 0, ccjs: 6, reg: 'C-GJWO' },
  { type: 'A321', finStart: 461, finEnd: 461, j: 16, o: 0, y: 174, fdjs: 1, ofcr: 0, ccjs: 6, reg: 'C-FGKN' },
  { type: 'A321', finStart: 462, finEnd: 462, j: 16, o: 0, y: 174, fdjs: 2, ofcr: 0, ccjs: 6, reg: 'C-FGKP' },
  { type: 'A321', finStart: 463, finEnd: 463, j: 16, o: 0, y: 180, fdjs: 2, ofcr: 0, ccjs: 6, reg: 'C-FGKZ' },
  { type: 'A321', finStart: 464, finEnd: 464, j: 16, o: 0, y: 180, fdjs: 2, ofcr: 0, ccjs: 6, reg: 'C-FJNX' },
  { type: 'A321', finStart: 465, finEnd: 465, j: 8, o: 0, y: 176, fdjs: 2, ofcr: 0, ccjs: 8, reg: 'C-GYFM' },
  { type: 'A321', finStart: 466, finEnd: 466, j: 8, o: 0, y: 176, fdjs: 2, ofcr: 0, ccjs: 8, reg: 'C-GYFY' },
  { type: 'A321', finStart: 467, finEnd: 467, j: 8, o: 0, y: 176, fdjs: 2, ofcr: 0, ccjs: 8, reg: 'C-GYGU' },
  { type: 'A321', finStart: 468, finEnd: 468, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-FJOK' },
  { type: 'A321 Rouge', finStart: 469, finEnd: 469, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-FJOU' },
  { type: 'A321 Rouge', finStart: 470, finEnd: 470, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-FJQD' },
  { type: 'A321 Rouge', finStart: 471, finEnd: 471, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-FJQH' },
  { type: 'A321 Rouge', finStart: 472, finEnd: 472, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-FJQL' },
  { type: 'A321', finStart: 473, finEnd: 473, j: 8, o: 0, y: 176, fdjs: 2, ofcr: 0, ccjs: 8, reg: 'C-FLKX' },
  { type: 'A321 Rouge', finStart: 474, finEnd: 474, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-FYXF' },
  { type: 'A321 Rouge', finStart: 475, finEnd: 475, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-GHPD' },
  { type: 'A321 Rouge', finStart: 476, finEnd: 476, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-GHPJ' },
  { type: 'A321 Rouge', finStart: 477, finEnd: 477, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-GHQG' },
  { type: 'A321 Rouge', finStart: 478, finEnd: 478, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-GHQI' },
  { type: 'A321 Rouge', finStart: 479, finEnd: 479, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-GJTH' },
  { type: 'A321 Rouge', finStart: 480, finEnd: 480, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-GJTX' },
  { type: 'A321 Rouge', finStart: 481, finEnd: 481, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-GKFA' },
  { type: 'A321 Rouge', finStart: 482, finEnd: 482, j: 12, o: 0, y: 184, fdjs: 2, ofcr: 0, ccjs: 5, reg: 'C-GKFB' },
  { type: 'A321', finStart: 483, finEnd: 483, j: 8, o: 0, y: 176, fdjs: 2, ofcr: 0, ccjs: 8, reg: 'C-FCEU' },
  { type: 'A321', finStart: 484, finEnd: 484, j: 8, o: 0, y: 176, fdjs: 2, ofcr: 0, ccjs: 8, reg: 'C-FFGZ' },
  { type: 'B737', finStart: 501, finEnd: 501, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FTJV' },
  { type: 'B737', finStart: 502, finEnd: 502, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSCY' },
  { type: 'B737', finStart: 503, finEnd: 503, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSDB' },
  { type: 'B737', finStart: 504, finEnd: 504, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSDQ' },
  { type: 'B737', finStart: 505, finEnd: 505, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSDW' },
  { type: 'B737', finStart: 506, finEnd: 506, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSEQ' },
  { type: 'B737', finStart: 507, finEnd: 507, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSES' },
  { type: 'B737', finStart: 508, finEnd: 508, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSIL' },
  { type: 'B737', finStart: 509, finEnd: 509, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSIP' },
  { type: 'B737', finStart: 510, finEnd: 510, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSIQ' },
  { type: 'B737', finStart: 511, finEnd: 511, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSJH' },
  { type: 'B737', finStart: 512, finEnd: 512, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSJJ' },
  { type: 'B737', finStart: 513, finEnd: 513, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSKZ' },
  { type: 'B737', finStart: 514, finEnd: 514, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSLU' },
  { type: 'B737', finStart: 515, finEnd: 515, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSNQ' },
  { type: 'B737', finStart: 516, finEnd: 516, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSNU' },
  { type: 'B737', finStart: 517, finEnd: 517, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSOC' },
  { type: 'B737', finStart: 518, finEnd: 518, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-FSOI' },
  { type: 'B737', finStart: 519, finEnd: 519, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEHI' },
  { type: 'B737', finStart: 520, finEnd: 520, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEHQ' },
  { type: 'B737', finStart: 521, finEnd: 521, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEHV' },
  { type: 'B737', finStart: 522, finEnd: 522, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEHY' },
  { type: 'B737', finStart: 523, finEnd: 523, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEIV' },
  { type: 'B737', finStart: 524, finEnd: 524, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEJL' },
  { type: 'B737', finStart: 525, finEnd: 525, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEJN' },
  { type: 'B737', finStart: 526, finEnd: 526, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEKH' },
  { type: 'B737', finStart: 527, finEnd: 527, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEKX' },
  { type: 'B737', finStart: 528, finEnd: 528, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEKZ' },
  { type: 'B737', finStart: 529, finEnd: 529, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GELJ' },
  { type: 'B737', finStart: 530, finEnd: 530, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GELQ' },
  { type: 'B737', finStart: 531, finEnd: 531, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GELU' },
  { type: 'B737', finStart: 532, finEnd: 532, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEMV' },
  { type: 'B737', finStart: 533, finEnd: 533, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEOJ' },
  { type: 'B737', finStart: 534, finEnd: 534, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEPB' },
  { type: 'B737', finStart: 535, finEnd: 535, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEPF' },
  { type: 'B737', finStart: 536, finEnd: 536, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GEPG' },
  { type: 'B737', finStart: 537, finEnd: 537, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GMEX' },
  { type: 'B737', finStart: 538, finEnd: 538, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GMIQ' },
  { type: 'B737', finStart: 539, finEnd: 539, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GMIU' },
  { type: 'B737', finStart: 540, finEnd: 540, j: 16, o: 0, y: 153, fdjs: 1, ofcr: 0, ccjs: 4, reg: 'C-GMIW' },
  { type: 'B737', finStart: 571, finEnd: 571, j: 0, o: 0, y: 189, fdjs: 1, ofcr: 0, ccjs: 5, reg: 'C-FFOP' },
  { type: 'B737', finStart: 572, finEnd: 572, j: 0, o: 0, y: 189, fdjs: 1, ofcr: 0, ccjs: 5 },
  { type: 'B737', finStart: 573, finEnd: 573, j: 0, o: 0, y: 189, fdjs: 1, ofcr: 0, ccjs: 5, notes: 'Row 11 no windows.', reg: 'C-FFIP' },
  { type: 'B737', finStart: 574, finEnd: 574, j: 0, o: 0, y: 189, fdjs: 1, ofcr: 0, ccjs: 5, reg: 'C-FFIQ' },
  { type: 'B737', finStart: 575, finEnd: 575, j: 0, o: 0, y: 189, fdjs: 1, ofcr: 0, ccjs: 5, reg: 'C-FFIS' },
  { type: 'B737', finStart: 576, finEnd: 576, j: 0, o: 0, y: 189, fdjs: 1, ofcr: 0, ccjs: 5, reg: 'C-FFJF' },
  { type: 'B737', finStart: 577, finEnd: 577, j: 0, o: 0, y: 189, fdjs: 1, ofcr: 0, ccjs: 5, reg: 'C-FFJG' },
  { type: 'B737', finStart: 578, finEnd: 578, j: 0, o: 0, y: 189, fdjs: 1, ofcr: 0, ccjs: 5, reg: 'C-FFNW' },
  { type: 'B767F', finStart: 637, finEnd: 637, j: 0, o: 0, y: 0, fdjs: 4, ofcr: 0, ccjs: 0, reg: 'C-FPCA' },
  { type: 'B767F', finStart: 638, finEnd: 638, j: 0, o: 0, y: 0, fdjs: 4, ofcr: 0, ccjs: 0, reg: 'C-FTCA' },
  { type: 'B767F', finStart: 639, finEnd: 639, j: 0, o: 0, y: 0, fdjs: 4, ofcr: 0, ccjs: 0, reg: 'C-FXCA' },
  { type: 'B767F', finStart: 646, finEnd: 646, j: 0, o: 0, y: 0, fdjs: 4, ofcr: 0, ccjs: 0, reg: 'C-GDUZ' },
  { type: 'B767F', finStart: 660, finEnd: 660, j: 0, o: 0, y: 0, fdjs: 4, ofcr: 0, ccjs: 0, reg: 'C-GHLU' },
  { type: 'B767F', finStart: 661, finEnd: 661, j: 0, o: 0, y: 0, fdjs: 4, ofcr: 0, ccjs: 0, reg: 'C-GHLV' },
  { type: 'B767F', finStart: 662, finEnd: 662, j: 0, o: 0, y: 0, fdjs: 4, ofcr: 0, ccjs: 0 },
  { type: 'B767F', finStart: 663, finEnd: 663, j: 0, o: 0, y: 0, fdjs: 4, ofcr: 0, ccjs: 0 },
  { type: '777-200LR', finStart: 701, finEnd: 701, j: 40, o: 24, y: 236, fdjs: 2, ofcr: 2, ccjs: 15, reg: 'C-FIUA' },
  { type: '777-200LR', finStart: 702, finEnd: 702, j: 40, o: 24, y: 236, fdjs: 2, ofcr: 2, ccjs: 15, reg: 'C-FIUF' },
  { type: '777-200LR', finStart: 703, finEnd: 703, j: 40, o: 24, y: 236, fdjs: 2, ofcr: 2, ccjs: 15, reg: 'C-FIUJ' },
  { type: '777-200LR', finStart: 704, finEnd: 704, j: 40, o: 24, y: 236, fdjs: 2, ofcr: 2, ccjs: 15, reg: 'C-FIVK' },
  { type: '777-200LR', finStart: 705, finEnd: 705, j: 40, o: 24, y: 236, fdjs: 2, ofcr: 2, ccjs: 15, reg: 'C-FNND' },
  { type: '777-200LR', finStart: 706, finEnd: 706, j: 40, o: 24, y: 236, fdjs: 2, ofcr: 2, ccjs: 15, reg: 'C-FNNH' },
  { type: '777-300', finStart: 731, finEnd: 731, j: 40, o: 24, y: 336, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FITL' },
  { type: '777-300', finStart: 732, finEnd: 732, j: 40, o: 24, y: 336, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FITU' },
  { type: '777-300', finStart: 733, finEnd: 733, j: 40, o: 24, y: 336, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FITW' },
  { type: '777-300', finStart: 734, finEnd: 734, j: 40, o: 24, y: 336, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FIUL' },
  { type: '777-300', finStart: 735, finEnd: 735, j: 40, o: 24, y: 336, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FIUR' },
  { type: '777-300', finStart: 736, finEnd: 736, j: 40, o: 24, y: 336, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FIUV' },
  { type: '777-300', finStart: 737, finEnd: 737, j: 40, o: 24, y: 336, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FIUW' },
  { type: '777-300', finStart: 738, finEnd: 738, j: 40, o: 24, y: 336, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FIVM' },
  { type: '777-300', finStart: 739, finEnd: 739, j: 40, o: 24, y: 336, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FRAM' },
  { type: '777-300', finStart: 740, finEnd: 740, j: 40, o: 24, y: 336, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FIVQ' },
  { type: '777-300', finStart: 741, finEnd: 741, j: 40, o: 24, y: 336, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FIVR' },
  { type: '777-300', finStart: 742, finEnd: 742, j: 40, o: 24, y: 336, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FIVS' },
  { type: '777-300HD', finStart: 743, finEnd: 743, j: 28, o: 24, y: 398, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FIVW' },
  { type: '777-300HD', finStart: 744, finEnd: 744, j: 28, o: 24, y: 398, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FIVX' },
  { type: '777-300HD', finStart: 745, finEnd: 745, j: 28, o: 24, y: 398, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FNNQ' },
  { type: '777-300HD', finStart: 746, finEnd: 746, j: 28, o: 24, y: 398, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FNNU' },
  { type: '777-300HD', finStart: 747, finEnd: 747, j: 28, o: 24, y: 398, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FNNW' },
  { type: '777-300HD', finStart: 748, finEnd: 748, j: 28, o: 24, y: 398, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FJZS' },
  { type: '777-300HD', finStart: 749, finEnd: 749, j: 28, o: 24, y: 398, fdjs: 2, ofcr: 2, ccjs: 16, reg: 'C-FKAU' },
  { type: '787-8', finStart: 801, finEnd: 801, j: 20, o: 21, y: 214, fdjs: 2, ofcr: 1, ccjs: 9, reg: 'C-GHPQ' },
  { type: '787-8', finStart: 802, finEnd: 802, j: 20, o: 21, y: 214, fdjs: 2, ofcr: 1, ccjs: 9, reg: 'C-GHPT' },
  { type: '787-8', finStart: 803, finEnd: 803, j: 20, o: 21, y: 214, fdjs: 2, ofcr: 1, ccjs: 9, reg: 'C-GHPU' },
  { type: '787-8', finStart: 804, finEnd: 804, j: 20, o: 21, y: 214, fdjs: 2, ofcr: 1, ccjs: 9, reg: 'C-GHPV' },
  { type: '787-8', finStart: 805, finEnd: 805, j: 20, o: 21, y: 214, fdjs: 2, ofcr: 1, ccjs: 9, reg: 'C-GHPX' },
  { type: '787-8', finStart: 806, finEnd: 806, j: 20, o: 21, y: 214, fdjs: 2, ofcr: 1, ccjs: 9, reg: 'C-GHPY' },
  { type: '787-8', finStart: 807, finEnd: 807, j: 20, o: 21, y: 214, fdjs: 2, ofcr: 1, ccjs: 9, reg: 'C-GHQQ' },
  { type: '787-8', finStart: 808, finEnd: 808, j: 20, o: 21, y: 214, fdjs: 2, ofcr: 1, ccjs: 9, reg: 'C-GHQY' },
  { type: '787-9', finStart: 831, finEnd: 831, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FNOE' },
  { type: '787-9', finStart: 832, finEnd: 832, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FNOG' },
  { type: '787-9', finStart: 833, finEnd: 833, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FNOH' },
  { type: '787-9', finStart: 834, finEnd: 834, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FNOI' },
  { type: '787-9', finStart: 835, finEnd: 835, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FGDT' },
  { type: '787-9', finStart: 836, finEnd: 836, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FGDX' },
  { type: '787-9', finStart: 837, finEnd: 837, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FGDZ' },
  { type: '787-9', finStart: 838, finEnd: 838, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FGEI' },
  { type: '787-9', finStart: 839, finEnd: 839, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FGEO' },
  { type: '787-9', finStart: 840, finEnd: 840, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FGFZ' },
  { type: '787-9', finStart: 841, finEnd: 841, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FPQB' },
  { type: '787-9', finStart: 842, finEnd: 842, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FGHZ' },
  { type: '787-9', finStart: 843, finEnd: 843, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FKSV' },
  { type: '787-9', finStart: 844, finEnd: 844, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FRSA' },
  { type: '787-9', finStart: 845, finEnd: 845, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FRSE' },
  { type: '787-9', finStart: 846, finEnd: 846, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FRSI' },
  { type: '787-9', finStart: 847, finEnd: 847, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FRSO' },
  { type: '787-9', finStart: 848, finEnd: 848, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FRSR' },
  { type: '787-9', finStart: 849, finEnd: 849, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FRTG' },
  { type: '787-9', finStart: 850, finEnd: 850, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FRTU' },
  { type: '787-9', finStart: 851, finEnd: 851, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FRTW' },
  { type: '787-9', finStart: 852, finEnd: 852, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FSBV' },
  { type: '787-9', finStart: 853, finEnd: 853, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FVLQ' },
  { type: '787-9', finStart: 854, finEnd: 854, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FVLU' },
  { type: '787-9', finStart: 855, finEnd: 855, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FVLX' },
  { type: '787-9', finStart: 856, finEnd: 856, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FVLZ' },
  { type: '787-9', finStart: 857, finEnd: 857, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FVNB' },
  { type: '787-9', finStart: 858, finEnd: 858, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FVND' },
  { type: '787-9', finStart: 859, finEnd: 859, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FVNF' },
  { type: '787-9', finStart: 860, finEnd: 860, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-GWUU' },
  { type: '787-9', finStart: 861, finEnd: 861, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-GYJW' },
  { type: '787-9', finStart: 862, finEnd: 862, j: 30, o: 21, y: 247, fdjs: 2, ofcr: 1, ccjs: 11, reg: 'C-FEGI' },
  { type: 'A330', finStart: 931, finEnd: 931, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GFAF' },
  { type: 'A330', finStart: 932, finEnd: 932, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GFAH' },
  { type: 'A330', finStart: 933, finEnd: 933, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GFAJ' },
  { type: 'A330', finStart: 934, finEnd: 934, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GFUR' },
  { type: 'A330', finStart: 935, finEnd: 935, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GHKR' },
  { type: 'A330', finStart: 936, finEnd: 936, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GHKW' },
  { type: 'A330', finStart: 937, finEnd: 937, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GHKX' },
  { type: 'A330', finStart: 938, finEnd: 938, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GHLM' },
  { type: 'A330', finStart: 939, finEnd: 939, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GEFA' },
  { type: 'A330', finStart: 940, finEnd: 940, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GEGC' },
  { type: 'A330', finStart: 941, finEnd: 941, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GEGI' },
  { type: 'A330', finStart: 942, finEnd: 942, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GEGP' },
  { type: 'A330', finStart: 943, finEnd: 943, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GHKC' },
  { type: 'A330', finStart: 944, finEnd: 944, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GKUG' },
  { type: 'A330', finStart: 945, finEnd: 945, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GKUH' },
  { type: 'A330', finStart: 946, finEnd: 946, j: 30, o: 0, y: 255, fdjs: 2, ofcr: 0, ccjs: 13, reg: 'C-GOFV' },
  { type: 'A330', finStart: 947, finEnd: 947, j: 32, o: 24, y: 241, fdjs: 2, ofcr: 0, ccjs: 11, reg: 'C-GOFW' },
  { type: 'A330', finStart: 948, finEnd: 948, j: 30, o: 0, y: 255, fdjs: 2, ofcr: 0, ccjs: 13, reg: 'C-GXZD' },
  { type: 'A330', finStart: 949, finEnd: 949, j: 30, o: 0, y: 255, fdjs: 2, ofcr: 0, ccjs: 13, reg: 'C-FDHG' },
  { type: 'A330', finStart: 950, finEnd: 950, j: 30, o: 0, y: 255, fdjs: 2, ofcr: 0, ccjs: 13, reg: 'C-FDHU' }
]);
const FDP_MAX_TABLE = [
  { start: 0, end: 239, label: '00:00-03:59', max14: 9, max56: 9, max14Over4: 8, max56Over4: 8 },
  { start: 240, end: 299, label: '04:00-04:59', max14: 10, max56: 9, max14Over4: 9, max56Over4: 8 },
  { start: 300, end: 359, label: '05:00-05:59', max14: 11.25, max56: 10.25, max14Over4: 10.25, max56Over4: 9.25 },
  { start: 360, end: 419, label: '06:00-06:59', max14: 12, max56: 11, max14Over4: 11, max56Over4: 10 },
  { start: 420, end: 779, label: '07:00-12:59', max14: 13, max56: 12, max14Over4: 12, max56Over4: 11 },
  { start: 780, end: 1019, label: '13:00-16:59', max14: 12.25, max56: 11.25, max14Over4: 11.25, max56Over4: 10.25 },
  { start: 1020, end: 1319, label: '17:00-21:59', max14: 12, max56: 11, max14Over4: 11, max56Over4: 10 },
  { start: 1320, end: 1379, label: '22:00-22:59', max14: 11, max56: 10, max14Over4: 10, max56Over4: 9 },
  { start: 1380, end: 1439, label: '23:00-23:59', max14: 10, max56: 9, max14Over4: 9, max56Over4: 8 }
];
const FDP_MAX_TABLE_OUTSIDE = [
  { start: 0, end: 239, label: '00:00-03:59', max: 9.25, deadhead: 12 },
  { start: 240, end: 299, label: '04:00-04:59', max: 10, deadhead: 12 },
  { start: 300, end: 359, label: '05:00-05:59', max: 11.25, deadhead: 14 },
  { start: 360, end: 1169, label: '06:00-19:29', max: 12, deadhead: 14 },
  { start: 1170, end: 1319, label: '19:30-21:59', max: 11, deadhead: 13 },
  { start: 1320, end: 1439, label: '22:00-23:59', max: 10, deadhead: 12 }
];
const FOM_FDP_TABLE = [
  { start: 0, end: 239, label: '00:00-03:59', max14: 9, max56: 9 },
  { start: 240, end: 299, label: '04:00-04:59', max14: 10, max56: 9 },
  { start: 300, end: 359, label: '05:00-05:59', max14: 11, max56: 10 },
  { start: 360, end: 419, label: '06:00-06:59', max14: 12, max56: 11 },
  { start: 420, end: 779, label: '07:00-12:59', max14: 13, max56: 12 },
  { start: 780, end: 1019, label: '13:00-16:59', max14: 12.5, max56: 11.5 },
  { start: 1020, end: 1319, label: '17:00-21:59', max14: 12, max56: 11 },
  { start: 1320, end: 1379, label: '22:00-22:59', max14: 11, max56: 10 },
  { start: 1380, end: 1439, label: '23:00-23:59', max14: 10, max56: 9 }
];
const AUGMENTED_FDP_TABLE = [
  { crew: 'basic+1', facility: 3, zone: 'inside', max: 14, deadhead: 16, facilityLabel: 'Class 3 seat' },
  { crew: 'basic+1', facility: 3, zone: 'outside', max: 12, deadhead: 14, facilityLabel: 'Class 3 seat' },
  { crew: 'basic+1', facility: 2, zone: 'any', max: 14, deadhead: 16, facilityLabel: 'Class 2 seat' },
  { crew: 'basic+1', facility: 1, zone: 'any', max: 15, deadhead: 17, facilityLabel: 'Class 1 bunk' },
  { crew: 'basic+2', facility: 1, zone: 'any', max: 18.25, deadhead: 18.25, facilityLabel: '2 Class 1 bunks' },
  { crew: '2ca2fo', facility: 1, zone: 'any', max: 20, deadhead: 20, facilityLabel: '2 Class 1 bunks' }
];
const FOM_AUGMENTED_FDP_TABLE = [
  { additionalCrew: 1, facility: 3, max: 14 },
  { additionalCrew: 1, facility: 2, max: 15 },
  { additionalCrew: 1, facility: 1, max: 15 },
  { additionalCrew: 2, facility: 3, max: 15.25 },
  { additionalCrew: 2, facility: 2, max: 16.5 },
  { additionalCrew: 2, facility: 1, max: 18 }
];
const WEATHER_API_ROOT = 'https://aviationweather.gov/api/data';
const WEATHER_STATION_ADDITIONAL_ATTEMPTS = 5;
const WEATHER_MAX_ATTEMPTS = 1 + WEATHER_STATION_ADDITIONAL_ATTEMPTS;
const WEATHER_RETRY_DELAY_MS = 100;
const WEATHER_CACHE_TTL_MS = 5 * 60 * 1000;
const WEATHER_REQUEST_TIMEOUT_MS = 4000;
const WEATHER_PRIME_BATCH_SIZE = 3;
const WEATHER_PRIME_DELAY_MS = 50;
const WEATHER_PRIME_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const METAR_HISTORY_LOOKBACK_HOURS = 6;
const METAR_TREND_MIN_CHANGE_CEILING_FT = 100;
const METAR_TREND_MIN_CHANGE_VIS_SM = 0.25;
const METAR_TREND_NOISE_CEILING_FT = 50;
const METAR_TREND_NOISE_VIS_SM = 0.125;
const MAJOR_CANADIAN_AIRPORTS = ['CYWG', 'CYYZ', 'CYVR', 'CYUL', 'CYYC', 'CYOW', 'CYEG', 'CYHZ', 'CYQB', 'CYQR'];
const MAJOR_US_AIRPORTS = ['KMCO', 'KTPA', 'KFLL', 'KLAS', 'KSFO', 'KDEN', 'KDFW', 'KBOS', 'KSEA', 'KMIA'];
const WEATHER_PRIME_TARGETS = Array.from(new Set([
  ...MAJOR_CANADIAN_AIRPORTS,
  ...MAJOR_US_AIRPORTS,
  'YYZ',
  'YWG',
  'CYYZ',
  'CYWG'
]));
const DEPARTURE_METAR_THRESHOLD_HRS = 1;
const METAR_JSON_ENDPOINTS = [
  (icao) => `${WEATHER_API_ROOT}/metar?format=json&ids=${icao}`,
  (icao) => `https://aviationweather.gov/cgi-bin/data/metar.php?format=json&ids=${icao}`
];
const TAF_JSON_ENDPOINTS = [
  (icao) => `${WEATHER_API_ROOT}/taf?format=json&ids=${icao}`,
  (icao) => `https://aviationweather.gov/cgi-bin/data/taf.php?format=json&ids=${icao}`
];
const METAR_HISTORY_JSON_ENDPOINTS = [
  (icao) => `${WEATHER_API_ROOT}/metar?format=json&ids=${icao}&hours=${METAR_HISTORY_LOOKBACK_HOURS}`,
  (icao) => `https://aviationweather.gov/cgi-bin/data/metar.php?format=json&ids=${icao}&hours=${METAR_HISTORY_LOOKBACK_HOURS}`
];
const METAR_TEXT_FALLBACKS = [
  (icao) => `https://tgftp.nws.noaa.gov/data/observations/metar/stations/${icao}.TXT`,
  (icao) => `https://metar.vatsim.net/${icao}`
];
const TAF_TEXT_FALLBACK = (icao) => `https://tgftp.nws.noaa.gov/data/forecasts/taf/stations/${icao}.TXT`;
const IATA_LOOKUP_URL = 'https://raw.githubusercontent.com/algolia/datasets/master/airports/airports.json';
const AIRPORT_TZ_LOOKUP_URL = 'https://raw.githubusercontent.com/mwgg/Airports/master/airports.json';
const CORS_PROXY_BUILDERS = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://cors.isomorphic-git.org/${url}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://thingproxy.freeboard.io/fetch/${url}`
];
const CORS_PROXY_PREFIXES = [
  'https://api.allorigins.win/raw?url=',
  'https://cors.isomorphic-git.org/',
  'https://corsproxy.io/?',
  'https://thingproxy.freeboard.io/fetch/'
];
const WEATHER_ALLOW_DIRECT_FOR_FORCED_PROXY = false;
const HOME_BASE_CODES = new Set(['YYZ', 'CYYZ']);
let airportLookupPromise = null;
let airportTimezonePromise = null;
const AIRPORT_TZ_FALLBACK = { YYZ: 'America/Toronto', CYYZ: 'America/Toronto' };
let airportTimezoneCache = { ...AIRPORT_TZ_FALLBACK };
const IATA_FALLBACK_MAP = {
  ABJ:'DIAP', ADD:'HAAB', AKL:'NZAA', AMS:'EHAM', ANU:'TAPA', ATL:'KATL', AUA:'TNCA', AUH:'OMAA', AZS:'MDCY',
  BAH:'OBBI', BCN:'LEBL', BDA:'TXKF', BDL:'KBDL', BGI:'TBPB', BJM:'HBBA', BKK:'VTBS', BNA:'KBNA', BOG:'SKBO',
  BOS:'KBOS', BRU:'EBBR', BWI:'KBWI', CCC:'MUCC', CDG:'LFPG', CKY:'GUCY', CLE:'KCLE', CLT:'KCLT', CMH:'KCMH',
  COO:'DBBB', CPH:'EKCH', CUN:'MMUN', CVG:'KCVG', CZM:'MMCZ', DCA:'KDCA', DEL:'VIDP', DEN:'KDEN', DFW:'KDFW',
  DKR:'GOOY', DLA:'FKKD', DOH:'OTHH', DTW:'KDTW', DUB:'EIDW', EBB:'HUEN', EWR:'KEWR', EZE:'SAEZ', FCO:'LIRF',
  FDF:'TFFF', FIH:'FZAA', FLL:'KFLL', FRA:'EDDF', GCM:'MWCR', GDN:'EPGD', GGT:'MYEF', GND:'TGPY', GRU:'SBGR',
  GUA:'MGGT', GVA:'LSGG', HAV:'MUHA', HKG:'VHHH', HND:'RJTT', HNL:'PHNL', HOG:'MUHG', IAD:'KIAD', IAH:'KIAH',
  ICN:'RKSI', IND:'KIND', IST:'LTFM', JED:'OEJN', JFK:'KJFK', KGL:'HRYR', KIN:'MKJP', LAD:'FNLU', LAS:'KLAS',
  LAX:'KLAX', LCA:'LCLK', LGA:'KLGA', LHR:'EGLL', LIM:'SPIM', LIR:'MRLB', MBJ:'MKJS', MCI:'KMCI', MCO:'KMCO',
  MDT:'KMDT', MEX:'MMMX', MIA:'KMIA', MKE:'KMKE', MSP:'KMSP', MSY:'KMSY', MUC:'EDDM', NAP:'LIRN', NAS:'MYNN',
  NBO:'HKJK', NRT:'RJAA', OGG:'PHOG', ORD:'KORD', OSL:'ENGM', OUA:'DFFD', PAP:'MTPP', PDX:'KPDX', PEK:'ZBAA',
  PHL:'KPHL', PHX:'KPHX', PIT:'KPIT', PLS:'MBPV', POP:'MDPP', PTP:'TFFR', PUJ:'MDPC', PVG:'ZSPD', PVR:'MMPR',
  RDU:'KRDU', ROC:'KROC', RSW:'KRSW', SAN:'KSAN', SCL:'SCEL', SEA:'KSEA', SFO:'KSFO', SJD:'MMSD', SJO:'MROC',
  SNU:'MUSC', SOF:'LBSF', STL:'KSTL', SYD:'YSSY', SYR:'KSYR', TLV:'LLBG', TPA:'KTPA', TRD:'ENVA', UVF:'TLPL',
  VIE:'LOWW', VLC:'LEVC', VNO:'EYVI', VRA:'MUVR', WAW:'EPWA', YAM:'CYAM', YBC:'CYBC', YBG:'CYBG', YBL:'CYBL',
  YCD:'CYCD', YCG:'CYCG', YDF:'CYDF', YEG:'CYEG', YFC:'CYFC', YGK:'CYGK', YGP:'CYGP', YGR:'CYGR', YHZ:'CYHZ',
  YKA:'CYKA', YLW:'CYLW', YMM:'CYMM', YOW:'CYOW', YPR:'CYPR', YQB:'CYQB', YQF:'CYQF', YQG:'CYQG', YQL:'CYQL',
  YQM:'CYQM', YQQ:'CYQQ', YQR:'CYQR', YQT:'CYQT', YQU:'CYQU', YQX:'CYQX', YQY:'CYQY', YQZ:'CYQZ', YSB:'CYSB',
  YSJ:'CYSJ', YTS:'CYTS', YTZ:'CYTZ', YUL:'CYUL', YUY:'CYUY', YVO:'CYVO', YVR:'CYVR', YWG:'CYWG', YWK:'CYWK',
  YWL:'CYWL', YXC:'CYXC', YXE:'CYXE', YXH:'CYXH', YXJ:'CYXJ', YXS:'CYXS', YXT:'CYXT', YXU:'CYXU', YXY:'CYXY',
  YYB:'CYYB', YYC:'CYYC', YYD:'CYYD', YYF:'CYYF', YYG:'CYYG', YYJ:'CYYJ', YYR:'CYYR', YYT:'CYYT', YYY:'CYYY',
  YYZ:'CYYZ', YZF:'CYZF', YZP:'CYZP', YZR:'CYZR', YZV:'CYZV', ZBF:'CZBF', ZRH:'LSZH', ZSA:'MYSM'
};

// --- Pay tables 2023–2026 (from contract) ---
const PAY_TABLES = {
  2023: { CA: { "777":{1:365.60,2:369.28,3:372.99,4:376.75,5:380.54,6:384.38,7:388.26,8:392.18,9:396.14,10:400.14,11:404.18,12:408.27},
                "787":{1:336.02,2:339.40,3:342.81,4:346.27,5:349.76,6:353.28,7:356.85,8:360.45,9:364.09,10:367.77,11:371.48,12:375.23},
                "330":{1:329.57,2:332.88,3:336.23,4:339.62,5:343.04,6:346.50,7:349.99,8:353.53,9:357.10,10:360.70,11:364.35,12:368.03},
                "767":{1:308.82,2:311.93,3:315.07,4:318.24,5:321.45,6:324.69,7:327.96,8:331.27,9:334.62,10:338.00,11:341.41,12:344.86},
                "320":{1:268.55,2:271.25,3:273.98,4:276.74,5:279.53,6:282.35,7:285.20,8:288.07,9:290.98,10:293.92,11:296.89,12:299.89},
                "737":{1:268.55,2:271.25,3:273.98,4:276.74,5:279.53,6:282.35,7:285.20,8:288.07,9:290.98,10:293.92,11:296.89,12:299.89},
                "220":{1:263.35,2:265.99,3:268.67,4:271.37,5:274.11,6:276.87,7:279.67,8:282.49,9:285.34,10:288.22,11:291.14,12:294.08} },
          FO: { "777":{1:84.12,2:91.16,3:138.01,4:148.82,5:207.40,6:215.25,7:223.25,8:231.39,9:239.66,10:248.09,11:256.66,12:265.37},
                "787":{1:84.12,2:91.16,3:126.84,4:136.78,5:190.62,6:197.84,7:205.19,8:212.67,9:220.27,10:228.02,11:235.89,12:243.90},
                "330":{1:84.12,2:91.16,3:124.41,4:134.15,5:186.96,6:194.04,7:201.25,8:208.58,9:216.04,10:223.64,11:231.36,12:239.22},
                "767":{1:84.12,2:91.16,3:116.57,4:125.70,5:175.19,6:181.82,7:188.58,8:195.45,9:202.44,10:209.56,11:216.80,12:224.16},
                "320":{1:84.12,2:91.16,3:115.07,4:123.15,5:156.54,6:162.35,7:168.27,8:174.29,9:180.41,10:186.64,11:192.98,12:199.43},
                "737":{1:84.12,2:91.16,3:115.07,4:123.15,5:156.54,6:162.35,7:168.27,8:174.29,9:180.41,10:186.64,11:192.98,12:199.43},
                "220":{1:84.12,2:91.16,3:112.84,4:120.76,5:153.50,6:159.20,7:165.00,8:170.91,9:176.91,10:183.02,11:189.24,12:195.56} },
          RP: { "777":{1:84.12,2:91.16,3:106.30,4:114.91,5:140.80,6:146.07,7:151.42,8:156.87,9:162.42,10:168.06,11:171.78,12:175.55},
                "787":{1:84.12,2:91.16,3:97.70,4:105.61,5:129.41,6:134.25,7:139.17,8:144.18,9:149.28,10:154.46,11:157.88,12:161.35},
                "330":{1:84.12,2:91.16,3:95.83,4:103.58,5:126.92,6:131.67,7:136.50,8:141.41,9:146.41,10:151.50,11:154.85,12:158.25} }
        },
  2024: { CA: { "777":{1:380.23,2:384.05,3:387.91,4:391.82,5:395.77,6:399.76,7:403.79,8:407.87,9:411.99,10:416.15,11:420.35,12:424.60},
                "787":{1:349.46,2:352.98,3:356.53,4:360.12,5:363.75,6:367.41,7:371.12,8:374.87,9:378.65,10:382.48,11:386.34,12:390.24},
                "330":{1:342.75,2:346.20,3:349.68,4:353.20,5:356.76,6:360.36,7:364.00,8:367.67,9:371.38,10:375.13,11:378.92,12:382.75},
                "767":{1:321.18,2:324.40,3:327.67,4:330.97,5:334.30,6:337.67,7:341.08,8:344.52,9:348.00,10:351.52,11:355.07,12:358.66},
                "320":{1:279.29,2:282.10,3:284.94,4:287.81,5:290.71,6:293.64,7:296.60,8:299.60,9:302.62,10:305.68,11:308.77,12:311.89},
                "737":{1:279.29,2:282.10,3:284.94,4:287.81,5:290.71,6:293.64,7:296.60,8:299.60,9:302.62,10:305.68,11:308.77,12:311.89},
                "220":{1:273.88,2:276.63,3:279.41,4:282.23,5:285.07,6:287.95,7:290.85,8:293.79,9:296.76,10:299.75,11:302.78,12:305.84} },
          FO: { "777":{1:87.48,2:94.81,3:143.53,4:154.77,5:215.69,6:223.86,7:232.18,8:240.64,9:249.25,10:258.01,11:266.92,12:275.99},
                "787":{1:87.48,2:94.81,3:131.92,4:142.25,5:198.24,6:205.75,7:213.40,8:221.17,9:229.09,10:237.14,11:245.33,12:253.66},
                "330":{1:87.48,2:94.81,3:129.38,4:139.51,5:194.43,6:201.80,7:209.30,8:216.93,9:224.69,10:232.58,11:240.62,12:248.79},
                "767":{1:87.48,2:94.81,3:121.24,4:130.73,5:182.20,6:189.10,7:196.12,8:203.27,9:210.54,10:217.94,11:225.47,12:233.13},
                "320":{1:87.48,2:94.81,3:119.67,4:128.07,5:162.80,6:168.84,7:175.00,8:181.26,9:187.63,10:194.11,11:200.70,12:207.40},
                "737":{1:87.48,2:94.81,3:119.67,4:128.07,5:162.80,6:168.84,7:175.00,8:181.26,9:187.63,10:194.11,11:200.70,12:207.40},
                "220":{1:87.48,2:94.81,3:117.35,4:125.59,5:159.64,6:165.57,7:171.60,8:177.74,9:183.99,10:190.34,11:196.81,12:203.38} },
          RP: { "777":{1:87.48,2:94.81,3:110.56,4:119.50,5:146.43,6:151.91,7:157.48,8:163.15,9:168.91,10:174.78,11:178.65,12:182.58},
                "787":{1:87.48,2:94.81,3:101.61,4:109.84,5:134.59,6:139.62,7:144.74,8:149.95,9:155.25,10:160.64,11:164.20,12:167.80},
                "330":{1:87.48,2:94.81,3:99.66,4:107.73,5:132.00,6:136.94,7:141.96,8:147.07,9:152.27,10:157.56,11:161.04,12:164.58} }
        },
  2025: { CA: { "777":{1:395.43,2:399.40,3:403.42,4:407.48,5:411.59,6:415.74,7:419.94,8:424.18,9:428.46,10:432.79,11:437.16,12:441.57},
                "787":{1:363.44,2:367.09,3:370.78,4:374.52,5:378.29,6:382.10,7:385.96,8:389.86,9:393.79,10:397.77,11:401.79,12:405.85},
                "330":{1:356.46,2:360.04,3:363.66,4:367.32,5:371.03,6:374.77,7:378.55,8:382.37,9:386.23,10:390.13,11:394.07,12:398.05},
                "767":{1:334.02,2:337.37,3:340.77,4:344.20,5:347.67,6:351.18,7:354.72,8:358.30,9:361.92,10:365.57,11:369.27,12:373.00},
                "320":{1:290.46,2:293.38,3:296.33,4:299.32,5:302.33,6:305.38,7:308.46,8:311.58,9:314.72,10:317.90,11:321.11,12:324.36},
                "737":{1:290.46,2:293.38,3:296.33,4:299.32,5:302.33,6:305.38,7:308.46,8:311.58,9:314.72,10:317.90,11:321.11,12:324.36},
                "220":{1:284.83,2:287.69,3:290.59,4:293.51,5:296.47,6:299.46,7:302.48,8:305.54,9:308.62,10:311.74,11:314.89,12:318.07} },
          FO: { "777":{1:90.98,2:98.60,3:149.27,4:160.96,5:224.32,6:232.82,7:241.46,8:250.26,9:259.22,10:268.33,11:277.60,12:287.02},
                "787":{1:90.98,2:98.60,3:137.19,4:147.93,5:206.17,6:213.98,7:221.93,8:230.02,9:238.24,10:246.62,11:255.14,12:263.80},
                "330":{1:90.98,2:98.60,3:134.55,4:145.09,5:202.21,6:209.87,7:217.67,8:225.60,9:233.67,10:241.88,11:250.24,12:258.73},
                "767":{1:90.98,2:98.60,3:126.08,4:135.96,5:189.48,6:196.66,7:203.96,8:211.40,9:218.96,10:226.66,11:234.48,12:242.45},
                "320":{1:90.98,2:98.60,3:124.46,4:133.20,5:169.31,6:175.59,7:181.99,8:188.50,9:195.13,10:201.87,11:208.72,12:215.70},
                "737":{1:90.98,2:98.60,3:124.46,4:133.20,5:169.31,6:175.59,7:181.99,8:188.50,9:195.13,10:201.87,11:208.72,12:215.70},
                "220":{1:90.98,2:98.60,3:122.05,4:130.61,5:166.02,6:172.19,7:178.46,8:184.85,9:191.34,10:197.95,11:204.68,12:211.51} },
          RP: { "777":{1:90.98,2:98.60,3:114.98,4:124.28,5:152.29,6:157.98,7:163.78,8:169.67,9:175.67,10:181.77,11:185.79,12:189.88},
                "787":{1:90.98,2:98.60,3:105.67,4:114.23,5:139.97,6:145.20,7:150.52,8:155.94,9:161.46,10:167.06,11:170.76,12:174.51},
                "330":{1:90.98,2:98.60,3:103.64,4:112.03,5:137.28,6:142.41,7:147.63,8:152.95,9:158.35,10:163.86,11:167.48,12:171.16} }
        },
  2026: { CA: { "777":{1:411.26,2:415.39,3:419.57,4:423.80,5:428.07,6:432.39,7:436.75,8:441.16,9:445.61,10:450.11,11:454.66,12:459.25},
                "787":{1:377.98,2:381.78,3:385.62,4:389.51,5:393.43,6:397.40,7:401.41,8:405.46,9:409.56,10:413.69,11:417.87,12:422.09},
                "330":{1:370.72,2:374.45,3:378.22,4:382.03,5:385.88,6:389.77,7:393.70,8:397.68,9:401.69,10:405.75,11:409.85,12:413.99},
                "767":{1:347.39,2:350.88,3:354.41,4:357.98,5:361.58,6:365.23,7:368.92,8:372.64,9:376.40,10:380.21,11:384.05,12:387.92},
                "320":{1:302.08,2:305.12,3:308.19,4:311.29,5:314.43,6:317.60,7:320.80,8:324.04,9:327.32,10:330.62,11:333.96,12:337.33},
                "737":{1:302.08,2:305.12,3:308.19,4:311.29,5:314.43,6:317.60,7:320.80,8:324.04,9:327.32,10:330.62,11:333.96,12:337.33},
                "220":{1:296.23,2:299.20,3:302.21,4:305.26,5:308.33,6:311.44,7:314.58,8:317.76,9:320.97,10:324.21,11:327.49,12:330.79} },
        FO: { "777":{1:94.62,2:102.54,3:155.24,4:167.40,5:233.30,6:242.14,7:251.13,8:260.28,9:269.60,10:279.07,11:288.71,12:298.51},
              "787":{1:94.62,2:102.54,3:142.68,4:153.86,5:214.42,6:222.54,7:230.81,8:239.22,9:247.78,10:256.49,11:265.35,12:274.36},
              "330":{1:94.62,2:102.54,3:139.94,4:150.90,5:210.30,6:218.27,7:226.38,8:234.63,9:243.02,10:251.56,11:260.25,12:269.09},
              "767":{1:94.62,2:102.54,3:131.13,4:141.40,5:197.06,6:204.53,7:212.13,8:219.86,9:227.72,10:235.73,11:243.87,12:252.15},
              "320":{1:94.62,2:102.54,3:129.44,4:138.53,5:176.08,6:182.62,7:189.27,8:196.05,9:202.94,10:209.94,11:217.07,12:224.33},
              "737":{1:94.62,2:102.54,3:129.44,4:138.53,5:176.08,6:182.62,7:189.27,8:196.05,9:202.94,10:209.94,11:217.07,12:224.33},
              "220":{1:94.62,2:102.54,3:126.93,4:135.84,5:172.67,6:179.08,7:185.61,8:192.25,9:199.00,10:205.87,11:212.87,12:219.98} },
        RP: { "777":{1:94.62,2:102.54,3:119.58,4:129.26,5:158.39,6:164.31,7:170.33,8:176.46,9:182.70,10:189.05,11:193.23,12:197.48},
              "787":{1:94.62,2:102.54,3:109.90,4:118.80,5:145.57,6:151.01,7:156.55,8:162.18,9:167.92,10:173.75,11:177.60,12:181.50},
              "330":{1:94.62,2:102.54,3:107.79,4:116.52,5:142.77,6:148.11,7:153.54,8:159.07,9:164.69,10:170.41,11:174.18,12:178.01} }
        }
};

// --- Projections 2027–2031 ---
const PROJECTION_SCENARIOS = {
  conservative: { label: 'Conservative', rates: [0.04, 0.03, 0.03, 0.03] },
  realistic: { label: 'Realistic', rates: [0.10, 0.045, 0.045, 0.045] },
  aggressive: { label: 'Aggressive', rates: [0.18, 0.06, 0.06, 0.06] }
};
const SLOPE_SCENARIOS = {
  conservative: {
    label: 'Conservative',
    foNb: { 3:0.42, 4:0.445, 5:0.56, 6:0.575, 7:0.59, 8:0.605, 9:0.62, 10:0.635, 11:0.65, 12:0.665 },
    foWb: { 3:0.37, 4:0.395, 5:0.545, 6:0.56, 7:0.575, 8:0.59, 9:0.605, 10:0.62, 11:0.635, 12:0.65 },
    rp: { 3:0.285, 4:0.305, 5:0.37, 6:0.38, 7:0.39, 8:0.40, 9:0.41, 10:0.42, 11:0.425, 12:0.43 }
  },
  realistic: {
    label: 'Realistic',
    foNb: { 3:0.46, 4:0.49, 5:0.565, 6:0.58, 7:0.595, 8:0.61, 9:0.625, 10:0.64, 11:0.655, 12:0.67 },
    foWb: { 3:0.42, 4:0.46, 5:0.55, 6:0.565, 7:0.58, 8:0.595, 9:0.61, 10:0.625, 11:0.64, 12:0.655 },
    rp: { 3:0.32, 4:0.345, 5:0.375, 6:0.385, 7:0.395, 8:0.405, 9:0.415, 10:0.425, 11:0.43, 12:0.435 }
  },
  aggressive: {
    label: 'Aggressive',
    foNb: { 3:0.50, 4:0.53, 5:0.57, 6:0.585, 7:0.60, 8:0.615, 9:0.63, 10:0.645, 11:0.66, 12:0.68 },
    foWb: { 3:0.47, 4:0.51, 5:0.56, 6:0.575, 7:0.59, 8:0.605, 9:0.62, 10:0.635, 11:0.65, 12:0.67 },
    rp: { 3:0.34, 4:0.36, 5:0.385, 6:0.40, 7:0.415, 8:0.43, 9:0.44, 10:0.45, 11:0.46, 12:0.47 }
  }
};
const PROJECTION_YEARS = [2027, 2028, 2029, 2030, 2031];
let currentProjectionScenario = 'realistic';
let currentSlopeScenario = 'realistic';

function getProjectionRates(scenarioKey){
  return PROJECTION_SCENARIOS[scenarioKey]?.rates || PROJECTION_SCENARIOS.realistic.rates;
}

function getSlopeScenario(scenarioKey){
  return SLOPE_SCENARIOS[scenarioKey] || SLOPE_SCENARIOS.realistic;
}

function buildProjectionFactors(rates){
  const factors = {};
  let cumulative = 1;
  PROJECTION_YEARS.forEach((year, idx) => {
    const rate = rates[Math.min(idx, rates.length - 1)];
    cumulative *= (1 + rate);
    factors[year] = cumulative;
  });
  return factors;
}

function rebuildProjections(scenarioKey){
  const base = PAY_TABLES[2026];
  if (!base) return;
  const rates = getProjectionRates(scenarioKey);
  const factors = buildProjectionFactors(rates);
  PROJECTION_YEARS.forEach((year) => {
    const factor = factors[year];
    const proj = {};
    for (const seat in base){
      proj[seat] = {};
      for (const ac in base[seat]){
        proj[seat][ac] = {};
        for (const k in base[seat][ac]){
          proj[seat][ac][k] = +(base[seat][ac][k] * factor).toFixed(2);
        }
      }
    }
    PAY_TABLES[year] = proj;
  });
  applyAnchoredSlopesFO_RP(currentSlopeScenario);
  applyConservativeRPCompression();
}

function refreshProjectedOutputs(){
  const annualOut = document.getElementById('modern-out');
  if (annualOut && annualOut.innerHTML.trim()){
    calcAnnualModern();
  }
  const monthlyOut = document.getElementById('modern-mon-out');
  if (monthlyOut && monthlyOut.innerHTML.trim()){
    calcMonthlyModern();
  }
  const voOut = document.getElementById('modern-ot-out');
  if (voOut && voOut.innerHTML.trim()){
    calcVOModern();
  }
}

function getModernPayYearForTab(tabId){
  if (tabId === 'modern-monthly') return document.getElementById('modern-mon-year');
  if (tabId === 'modern-vo') return document.getElementById('modern-ot-year');
  return document.getElementById('modern-year');
}

function updateProjectionControlsVisibility(){
  const controls = document.getElementById('modern-projection-controls');
  if (!controls) return;
  const yearSelect = getModernPayYearForTab(currentModernSubTab);
  const yearValue = Number(yearSelect?.value);
  const shouldShow = Number.isFinite(yearValue) && yearValue >= 2027;
  controls.classList.toggle('hidden', !shouldShow);
}

function setProjectionScenario(scenarioKey, { recalc = true } = {}){
  currentProjectionScenario = scenarioKey in PROJECTION_SCENARIOS ? scenarioKey : 'realistic';
  rebuildProjections(currentProjectionScenario);
  if (recalc){
    refreshProjectedOutputs();
  }
}

function setSlopeScenario(scenarioKey, { recalc = true } = {}){
  currentSlopeScenario = scenarioKey in SLOPE_SCENARIOS ? scenarioKey : 'realistic';
  rebuildProjections(currentProjectionScenario);
  if (recalc){
    refreshProjectedOutputs();
  }
}

// === Projected 2027–2031: FO & RP anchored to CA Step 12 ===
// Captain "composite" anchor interpreted as CA Step 12 on the same fleet/year.
// FO1/FO2 remain flat across fleets (use the year's flat values as‑is).

const NB_FLEETS = new Set(['320','737','220']);           // narrow-body
const WB_FLEETS = new Set(['777','787','330','767']);      // wide-body

function applyAnchoredSlopesFO_RP(scenarioKey) {
  const scenario = getSlopeScenario(scenarioKey);
  const multFoNb = scenario.foNb;
  const multFoWb = scenario.foWb;
  const multRp = scenario.rp;
  const YEARS = [2027, 2028, 2029, 2030, 2031];
  YEARS.forEach((y) => {
    const yr = PAY_TABLES[y];
    if (!yr || !yr.CA) return;

    // Use the year's FO1/FO2 (flat) from any AC to enforce uniformity
    let flatFO1, flatFO2;
    if (yr.FO) {
      const ac0 = Object.keys(yr.FO)[0];
      if (ac0) {
        flatFO1 = yr.FO[ac0][1];
        flatFO2 = yr.FO[ac0][2];
      }
    }

    for (const ac of Object.keys(yr.CA)) {
      const ca = yr.CA[ac]; if (!ca || !ca[12]) continue;
      const ca12 = ca[12];

      // ---- FO (anchor to CA12 with NB/WB slopes) ----
      if (yr.FO && yr.FO[ac]) {
        const fo = yr.FO[ac];

        // Keep FO1/FO2 flat across fleets
        if (typeof flatFO1 === 'number') fo[1] = flatFO1;
        if (typeof flatFO2 === 'number') fo[2] = flatFO2;

        const map = NB_FLEETS.has(ac) ? multFoNb : multFoWb;
        for (let s = 3; s <= 12; s++) {
          const m = map[s]; if (!m) continue;
          const target = +(ca12 * m).toFixed(2);
          // Only raise (never lower) any prior projection
          fo[s] = Math.max(fo[s] || 0, target);
        }
        // Monotonic guard
        for (let s = 2; s <= 12; s++) {
          if (fo[s] < fo[s-1]) fo[s] = fo[s-1];
        }
      }

      // ---- RP (anchor to CA12; same curve for all fleets) ----
      if (yr.RP && yr.RP[ac]) {
        const rp = yr.RP[ac];
        for (let s = 3; s <= 12; s++) {
          const m = multRp[s]; if (!m) continue;
          const target = +(ca12 * m).toFixed(2);
          rp[s] = Math.max(rp[s] || 0, target);
        }
        for (let s = 2; s <= 12; s++) {
          if (rp[s] < rp[s-1]) rp[s] = rp[s-1];
        }
      }
    }
  });
}

// === Conservative RP1–4 discount compression for 2027–2031 ===
// Discounts vs RP Step 5 on the same aircraft.
const RP_EARLY_CONSERVATIVE = { 1: 0.42, 2: 0.35, 3: 0.22, 4: 0.15 };

function applyConservativeRPCompression() {
  const years = [2027, 2028, 2029, 2030, 2031];
  years.forEach((y) => {
    const rp = PAY_TABLES[y] && PAY_TABLES[y].RP;
    if (!rp) return;
    Object.keys(rp).forEach((ac) => {
      const step5 = rp[ac][5];
      if (!step5) return;
      for (let s = 1; s <= 4; s++) {
        const target = +(step5 * (1 - RP_EARLY_CONSERVATIVE[s])).toFixed(2);
        rp[ac][s] = Math.max(rp[ac][s] || 0, target);
      }
    });
  });
}

// Run after projections
setProjectionScenario(currentProjectionScenario, { recalc: false });

// --- 2025 Tax Data ---
const FED = { brackets:[[57375,0.145],[114750,0.205],[177882,0.26],[253414,0.29],[Infinity,0.33]],
              bpa_base:14538,bpa_additional:1591,bpa_addl_start:177882,bpa_addl_end:253414 };
const PROV = {
  AB:{brackets:[[60000,0.08],[151234,0.10],[181481,0.12],[241974,0.13],[362961,0.14],[Infinity,0.15]], bpa:22323},
  BC:{brackets:[[49279,0.0506],[98560,0.077],[113158,0.105],[137407,0.1229],[186306,0.147],[259829,0.168],[Infinity,0.205]], bpa:12932},
  MB:{brackets:[[47000,0.108],[100000,0.1275],[Infinity,0.174]], bpa:15780, bpa_phase_out_start:200000, bpa_phase_out_end:400000},
  NB:{brackets:[[51306,0.094],[102614,0.14],[190060,0.16],[Infinity,0.195]], bpa:13261},
  NL:{brackets:[[44192,0.087],[88382,0.145],[157792,0.158],[220910,0.178],[282214,0.198],[564429,0.208],[1128858,0.213],[Infinity,0.218]], bpa:10882},
  NS:{brackets:[[30507,0.0879],[61015,0.1495],[95883,0.1667],[154650,0.175],[Infinity,0.21]], bpa:8841},
  NT:{brackets:[[51964,0.059],[103930,0.086],[168967,0.122],[Infinity,0.1405]], bpa:16673},
  NU:{brackets:[[54707,0.04],[109413,0.07],[177881,0.09],[Infinity,0.115]], bpa:16862},
  ON:{brackets:[[52886,0.0505],[105775,0.0915],[150000,0.1116],[220000,0.1216],[Infinity,0.1316]], bpa:12399},
  PE:{brackets:[[33328,0.095],[64656,0.1347],[105000,0.166],[140000,0.1762],[Infinity,0.19]], bpa:13000},
  QC:{brackets:[[53255,0.14],[106495,0.19],[129590,0.24],[Infinity,0.2575]], bpa:18571},
  SK:{brackets:[[53463,0.105],[152750,0.125],[Infinity,0.145]], bpa:19241},
  YT:{brackets:[[57375,0.064],[114750,0.09],[177882,0.109],[500000,0.128],[Infinity,0.15]], bpa:15805}
};
// --- 2026 Tax Data ---
// Federal: threshold and rates indexed for 2026; BPA increases with clawback starting at $181,440 and ending at $258,482.
const FED_2026 = { brackets:[[58523,0.14],[117045,0.205],[181440,0.26],[258482,0.29],[Infinity,0.33]],
                   bpa_base:14829,bpa_additional:1623,bpa_addl_start:181440,bpa_addl_end:258482 };
// Provincial: 2026 brackets indexed; BPAs generally mirror 2025 values except where noted (AB and BC).
const PROV_2026 = {
  AB:{brackets:[[61200,0.08],[154259,0.10],[185111,0.12],[246813,0.13],[370220,0.14],[Infinity,0.15]], bpa:22769},
  BC:{brackets:[[50363,0.0506],[100728,0.077],[115648,0.105],[140430,0.1229],[190405,0.147],[265545,0.168],[Infinity,0.205]], bpa:13216},
  MB:{brackets:[[47000,0.108],[100000,0.1275],[Infinity,0.174]], bpa:15780, bpa_phase_out_start:200000, bpa_phase_out_end:400000},
  NB:{brackets:[[52333,0.094],[104666,0.14],[193861,0.16],[Infinity,0.195]], bpa:13261},
  NL:{brackets:[[44678,0.087],[89355,0.145],[154639,0.158],[215913,0.178],[275999,0.198],[551999,0.208],[1103999,0.213],[Infinity,0.218]], bpa:10882},
  NS:{brackets:[[30995,0.0879],[61991,0.1495],[97417,0.1667],[157124,0.175],[Infinity,0.21]], bpa:8841},
  NT:{brackets:[[53003,0.059],[106009,0.086],[172346,0.122],[Infinity,0.1405]], bpa:16673},
  NU:{brackets:[[55801,0.04],[111602,0.07],[181439,0.09],[Infinity,0.115]], bpa:16862},
  ON:{brackets:[[53891,0.0505],[107785,0.0915],[150000,0.1116],[220000,0.1216],[Infinity,0.1316]], bpa:12399},
  PE:{brackets:[[33928,0.095],[65820,0.1347],[106890,0.166],[142250,0.1762],[Infinity,0.19]], bpa:13000},
  QC:{brackets:[[53255,0.14],[106495,0.19],[129590,0.24],[Infinity,0.2575]], bpa:18571},
  SK:{brackets:[[54532,0.105],[155805,0.125],[Infinity,0.145]], bpa:19241},
  YT:{brackets:[[58523,0.064],[117045,0.09],[181440,0.109],[500000,0.128],[Infinity,0.15]], bpa:15805}
};

const CPP = {ympe:71300,yampe:81200,ybe:3500, rate_base:0.0595, rate_cpp2:0.04, max_base:4034.10, max_cpp2:396.00};
const QPP = {ympe:71300,yampe:81200,ybe:3500, rate_base_total:0.064, rate_qpp2:0.04};
const EI = {mie:65700, rate:0.0164, rate_qc:0.0131, max_prem:1077.48, max_prem_qc:860.67};

// --- Helpers ---
function clampStep(s){ s=+s; if (s<1) return 1; if (s>12) return 12; return s; }

/*
 * Compute the federal basic personal amount (BPA) for a given income and year.
 * For 2025 the BPA ranges from $14,538 to $16,129 with clawback between
 * $177,882 and $253,414.  For 2026 the BPA ranges from $14,829 to $16,452
 * with clawback between $181,440 and $258,482.  Years 2025 and prior use
 * the 2025 data; years 2026 and beyond use the 2026 data.
 */
function federalBPA(year, income){
  const b = (year <= 2025 ? FED : FED_2026);
  let addl = 0;
  if (income <= b.bpa_addl_start) addl = b.bpa_additional;
  else if (income < b.bpa_addl_end){
    const frac = (b.bpa_addl_end - income) / (b.bpa_addl_end - b.bpa_addl_start);
    addl = b.bpa_additional * Math.max(0, Math.min(1, frac));
  }
  return b.bpa_base + addl;
}

function provincialBPA(year, income, province){
  const provMap = (year <= 2025 ? PROV : PROV_2026);
  const p = provMap[province];
  if (!p) throw new Error('Unsupported province '+province);
  if (p.bpa_phase_out_start && p.bpa_phase_out_end){
    if (income <= p.bpa_phase_out_start) return p.bpa;
    if (income >= p.bpa_phase_out_end) return 0;
    const frac = (p.bpa_phase_out_end - income) / (p.bpa_phase_out_end - p.bpa_phase_out_start);
    return p.bpa * Math.max(0, Math.min(1, frac));
  }
  return p.bpa;
}

function taxFromBrackets(taxable, brackets){
  let tax=0,last=0;
  for (let i=0;i<brackets.length;i++){
    const cap=brackets[i][0], rate=brackets[i][1];
    const slice=Math.min(taxable,cap)-last;
    if (slice>0){ tax+=slice*rate; last=cap; }
    if (taxable<=cap) break;
  }
  return Math.max(0,tax);
}
function marginalRate(amount, brackets){
  for (let i=0;i<brackets.length;i++){ if (amount<=brackets[i][0]) return brackets[i][1]; }
  return brackets[brackets.length-1][1];
}
function pensionRateOnDate(d){ const years=(d-DOH)/(365.2425*24*3600*1000); if (years<2) return 0.06; if (years<5) return 0.065; return 0.07; }
function pensionRateForStep(step){
  const s = clampStep(step);
  if (s <= 2) return 0.06;
  if (s <= 5) return 0.065;
  return 0.07;
}
function advanceGrossForSeatStep(seat, step){
  const s = clampStep(step);
  if (seat === 'CA') return 6500;
  if (seat === 'RP') return s <= 2 ? 3250 : 4000;
  if (seat === 'FO') return s <= 2 ? 3250 : 5000;
  return 0;
}
function stepOnJan1(selectedStep, tieOn, year){ return tieOn ? clampStep((year-2025)+1) : clampStep(selectedStep); }
function rateFor(seat, ac, year, step, xlr){
  const table = PAY_TABLES[year] && PAY_TABLES[year][seat];
  if (!table) throw new Error('Missing pay table for '+year+' '+seat);
  if (seat==='RP' && ['777','787','330'].indexOf(ac)===-1) throw new Error('RP seat only on 777/787/330');
  let rate = table[ac][clampStep(step)];
  if (xlr && ac==='320' && !(seat==='FO' && (step===1||step===2))) rate += 2.46;
  return rate;
}
function yearSegments(year, stepJan1){
  const jan1=new Date(Date.UTC(year,0,1));
  const sep30=new Date(Date.UTC(year, SWITCH.m-1, SWITCH.d));
  const nov10=new Date(Date.UTC(year, PROGRESSION.m-1, PROGRESSION.d));
  const dec31=new Date(Date.UTC(year,11,31));
  const prev=year-1;
  return [
    {start:jan1, end:new Date(sep30.getTime()-86400000), payYear:prev, step:stepJan1},
    {start:sep30, end:new Date(nov10.getTime()-86400000), payYear:year, step:stepJan1},
    {start:nov10, end:dec31, payYear:year, step:clampStep(stepJan1+1)}
  ];
}
function daysInclusive(a,b){ return Math.round((b-a)/86400000)+1; }
function money(x){ return '$'+(x||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
// ---- CPP/QPP & EI precise daily caps ----
// ---- CPP/QPP & EI precise daily caps (cumulative method) ----
function computeCPP_EI_Daily({ year, seat, ac, stepJan1, xlrOn, avgMonthlyHours, province }) {
  const segs = yearSegments(year, stepJan1);
  const dailyHours = avgMonthlyHours * 12 / 365.2425;
  const inQC = (province === 'QC');

  let cpp = 0, ei = 0;

  // Cumulative earnings trackers (used to compute incremental eligible bases)
  let cumGross = 0;           // cumulative pensionable/insurable gross
  let cumEIBase = 0;          // EI base already counted
  let cumBaseElig = 0;        // CPP/QPP Tier‑1 eligible base counted (above YBE, up to YMPE)
  let cumTier2Elig = 0;       // CPP2/QPP2 eligible base counted (between YMPE and YAMPE)

  for (let t = Date.UTC(year,0,1); t <= Date.UTC(year,11,31); t += 86400000) {
    const day = new Date(t);

    // Which pay table/step applies today
    let py = year, st = stepJan1;
    for (const s of segs) { if (day >= s.start && day <= s.end) { py = s.payYear; st = s.step; break; } }
    const rate = rateFor(seat, ac, py, st, !!xlrOn);
    const g = dailyHours * rate;           // today's gross
    cumGross += g;

    // --- EI (cap by MIE; incremental contribution on new eligible amount) ---
    {
      const ei_rate = inQC ? EI.rate_qc : EI.rate;
      const ei_maxPrem = inQC ? EI.max_prem_qc : EI.max_prem;
      const eiEligibleToDate = Math.min(cumGross, EI.mie);
      const addEIBase = Math.max(0, eiEligibleToDate - cumEIBase);
      ei += addEIBase * ei_rate;
      cumEIBase += addEIBase;
      if (ei > ei_maxPrem) ei = ei_maxPrem; // rounding guard
    }

    // --- CPP/QPP base (Tier‑1) & Tier‑2 using cumulative windows ---
    if (inQC) {
      // QPP Tier‑1: between YBE and YMPE
      const baseEligToDate = Math.max(0, Math.min(cumGross, QPP.ympe) - QPP.ybe);
      const addBase = Math.max(0, baseEligToDate - cumBaseElig);
      cpp += addBase * QPP.rate_base_total;
      cumBaseElig += addBase;

      // QPP2: between YMPE and YAMPE
      const tier2EligToDate = Math.max(0, Math.min(cumGross, QPP.yampe) - QPP.ympe);
      const add2 = Math.max(0, tier2EligToDate - cumTier2Elig);
      cpp += add2 * QPP.rate_qpp2;
      cumTier2Elig += add2;
    } else {
      // CPP Tier‑1: between YBE and YMPE
      const baseEligToDate = Math.max(0, Math.min(cumGross, CPP.ympe) - CPP.ybe);
      const addBase = Math.max(0, baseEligToDate - cumBaseElig);
      cpp += addBase * CPP.rate_base;
      cumBaseElig += addBase;

      // CPP2: between YMPE and YAMPE
      const tier2EligToDate = Math.max(0, Math.min(cumGross, CPP.yampe) - CPP.ympe);
      const add2 = Math.max(0, tier2EligToDate - cumTier2Elig);
      cpp += add2 * CPP.rate_cpp2;
      cumTier2Elig += add2;
    }
  }

  return { cpp_total: +cpp.toFixed(2), ei: +ei.toFixed(2) };
}
// ---- Best‑effort haptic tap ----
const hapticTap = (() => {
  return (el) => {
    try { if (navigator.vibrate) navigator.vibrate(10); } catch(e){}
    // micro visual pulse
    if (el) { el.classList.add('haptic-tap'); setTimeout(()=>el.classList.remove('haptic-tap'), 140); }
  };
})();

let lastTapAt = 0;
function addTapListener(el, handler){
  if (!el || typeof handler !== 'function') return;
  const wrapped = (event) => {
    if (event.type === 'pointerup'){
      if (event.pointerType === 'mouse' && event.button && event.button !== 0) return;
      lastTapAt = Date.now();
      handler(event);
      return;
    }
    if (event.type === 'touchend'){
      lastTapAt = Date.now();
      handler(event);
      return;
    }
    if (event.type === 'click'){
      if (Date.now() - lastTapAt < 450) return;
      handler(event);
    }
  };
  if (window.PointerEvent){
    el.addEventListener('pointerup', wrapped);
  } else {
    el.addEventListener('touchend', wrapped, { passive: true });
  }
  el.addEventListener('click', wrapped);
}
// ---- Union dues at 1.85% of gross, computed monthly ----
function computeUnionDuesMonthly({ year, seat, ac, stepJan1, xlrOn, avgMonthlyHours }) {
  const segs = yearSegments(year, stepJan1);
  const dailyHours = avgMonthlyHours * 12 / 365.2425;
  const monthsGross = new Array(12).fill(0);

  for (let t = Date.UTC(year,0,1); t <= Date.UTC(year,11,31); t += 86400000) {
    const day = new Date(t), m = day.getUTCMonth();
    let py = year, st = stepJan1;
    for (const s of segs) { if (day >= s.start && day <= s.end) { py = s.payYear; st = s.step; break; } }
    const rate = rateFor(seat, ac, py, st, !!xlrOn);
    monthsGross[m] += dailyHours * rate;
  }

  const duesByMonth = monthsGross.map(g => +(g * 0.0185).toFixed(2));
  const annual = +(duesByMonth.reduce((a,b)=>a+b, 0).toFixed(2));
  const avgMonthly = +(annual / 12).toFixed(2);
  return { duesByMonth, annual, avgMonthly };
}

function segmentForDate(day, segs, year, stepJan1){
  for (const s of segs) {
    if (day >= s.start && day <= s.end) return s;
  }
  return { payYear: year, step: stepJan1 };
}

function computeMonthlyGrosses({ year, seat, ac, stepJan1, xlrOn, avgMonthlyHours }){
  const segs = yearSegments(year, stepJan1);
  const dailyHours = avgMonthlyHours * 12 / 365.2425;
  const monthsGross = new Array(12).fill(0);
  const monthSteps = new Array(12).fill(stepJan1);

  for (let m = 0; m < 12; m++) {
    const monthDate = new Date(Date.UTC(year, m, 1));
    monthSteps[m] = segmentForDate(monthDate, segs, year, stepJan1).step;
  }

  for (let t = Date.UTC(year,0,1); t <= Date.UTC(year,11,31); t += 86400000) {
    const day = new Date(t);
    const seg = segmentForDate(day, segs, year, stepJan1);
    const rate = rateFor(seat, ac, seg.payYear, seg.step, !!xlrOn);
    monthsGross[day.getUTCMonth()] += dailyHours * rate;
  }

  return { monthsGross, monthSteps };
}

// --- Annual computation ---
function computeAnnual(params){
  const seat=params.seat, ac=params.ac, year=+params.year, province=params.province;
  const stepJan1 = stepOnJan1(params.stepInput, !!params.tieOn, year);
  const segs = yearSegments(year, stepJan1);
  const dailyHours = (+params.avgMonthlyHours)*12/365.2425;
  const audit=[]; let gross=0;
  for (let seg of segs){
    const r=rateFor(seat, ac, seg.payYear, seg.step, !!params.xlrOn);
    const d=daysInclusive(seg.start, seg.end);
    const h=dailyHours*d;
    const pay=h*r;
    gross += pay;
    audit.push({start:seg.start, end:seg.end, pay_table_year:seg.payYear, step:seg.step, hourly:r, days:d, hours:h, segment_gross:pay});
  }
  // Pension accrual loop
  let pension=0;
  for (let t=Date.UTC(year,0,1); t<=Date.UTC(year,11,31); t+=86400000){
    const day=new Date(t);
    const pct = pensionRateOnDate(day);
    let py=year, st=stepJan1;
    for (let s of segs){ if (day>=s.start && day<=s.end){ py=s.payYear; st=s.step; break; } }
    const rate = rateFor(seat, ac, py, st, !!params.xlrOn);
    const dayPay = dailyHours*rate; pension += dayPay*pct;
  }
  const rrsp = Math.max(0, +params.rrsp || 0);
  // Taxable income before RRSP: used to compute original tax and monthly figures
  const taxable_pre = Math.max(0, gross - pension);

  // Precise CPP/QPP & EI using daily caps.  These represent the full year contributions
  // if the CPP/EI cap has not yet been reached.
  const ded = computeCPP_EI_Daily({
    year,
    seat,
    ac,
    stepJan1,
    xlrOn: !!params.xlrOn,
    avgMonthlyHours: +params.avgMonthlyHours,
    province
  });
  const cpp_total_full = ded.cpp_total;
  const eiPrem_full    = ded.ei;
  const cpp_total_deduct = cpp_total_full;
  const eiPrem_deduct   = eiPrem_full;

  // Determine appropriate tax data sets based on year
  const fedData = (year <= 2025 ? FED : FED_2026);
  const provMap = (year <= 2025 ? PROV : PROV_2026);
  const p = provMap[province];
  if (!p) throw new Error('Unsupported province '+province);
  // Taxes with credits on lowest rates
  const fed_gross_pre  = taxFromBrackets(taxable_pre, fedData.brackets);
  const prov_gross_pre = taxFromBrackets(taxable_pre, p.brackets);
  const fed_low = fedData.brackets[0][1];
  const prov_low = p.brackets[0][1];
  const fed_tax_pre  = Math.max(0, fed_gross_pre - (fed_low * federalBPA(year, taxable_pre) + 0.15 * (cpp_total_full + eiPrem_full)));
  const prov_tax_pre = Math.max(0, prov_gross_pre - (prov_low * provincialBPA(year, taxable_pre, province) + prov_low * (cpp_total_full + eiPrem_full)));
  const income_tax_pre = fed_tax_pre + prov_tax_pre;

  // ESOP contribution based on gross
  const esop = Math.min((+params.esopPct/100)*gross, 30000);

  // Union dues (1.85% of gross) computed monthly
  const union = computeUnionDuesMonthly({
    year,
    seat,
    ac,
    stepJan1,
    xlrOn: !!params.xlrOn,
    avgMonthlyHours: +params.avgMonthlyHours
  });

  // Compute taxable income after RRSP and union dues (used for tax-return calculation only)
  const taxable_rrsp = Math.max(0, taxable_pre - rrsp - union.annual);
  const fed_gross_rrsp  = taxFromBrackets(taxable_rrsp, fedData.brackets);
  const prov_gross_rrsp = taxFromBrackets(taxable_rrsp, p.brackets);
  const fed_tax_rrsp  = Math.max(0, fed_gross_rrsp - (fed_low * federalBPA(year, taxable_rrsp) + 0.15 * (cpp_total_full + eiPrem_full)));
  const prov_tax_rrsp = Math.max(0, prov_gross_rrsp - (prov_low * provincialBPA(year, taxable_rrsp, province) + prov_low * (cpp_total_full + eiPrem_full)));
  // Taxes on income after RRSP contributions are used only to compute the tax return
  const income_tax_rrsp = fed_tax_rrsp + prov_tax_rrsp;

  // Income tax used for annual and monthly net is the tax before RRSP contributions.  The RRSP
  // deduction does not reduce current year taxes in the pay calculation.  See tax_return below
  // for the refund effect.
  const income_tax = income_tax_pre;

  // ESOP match after tax uses the marginal rate at the taxable income before RRSP contributions
  const comb_top = marginalRate(taxable_pre, fedData.brackets) + marginalRate(taxable_pre, p.brackets);
  const esop_match_net = +(0.30 * esop * (1 - comb_top)).toFixed(2);

  // Totals
  const annual_health = HEALTH_MO*12;
  // Annual net: subtract tax, full CPP/QPP & EI contributions, health, union dues, and employee ESOP (ESOP is after-tax).
  // Annual net does not depend on the Maxed CPP/EI toggle – always use full contributions.
  const net = gross - income_tax - cpp_total_full - eiPrem_full - annual_health - union.annual - esop;

  // Monthly results: do not adjust net for RRSP contributions; use pre‑RRSP taxable tax and net for monthly snapshot
  const monthly = {
    gross: +(gross/12).toFixed(2),
    // monthly net excludes ESOP contributions and match.  Because income_tax equals income_tax_pre
    // (i.e., taxes are not reduced by RRSP), use income_tax here.
    net: +(((gross - income_tax - cpp_total_deduct - eiPrem_deduct - annual_health - union.annual + esop_match_net) - esop - esop_match_net)/12).toFixed(2),
    income_tax: +(income_tax/12).toFixed(2),
    cpp: +((cpp_total_deduct)/12).toFixed(2),
    ei: +((eiPrem_deduct)/12).toFixed(2),
    health: +(annual_health/12).toFixed(2),
    pension: +(pension/12).toFixed(2),
    esop: +(esop/12).toFixed(2),
    esop_match_after_tax: +(esop_match_net/12).toFixed(2),
    union_dues: +(union.annual/12).toFixed(2)
  };

  
  // Annual tax return: compare annual liability to estimated withholdings across two
  // paycheques per month using fixed advance amounts, second cheques annualized at 24,
  // and pension based on the full month's gross.
  const monthlyBreakdown = computeMonthlyGrosses({
    year,
    seat,
    ac,
    stepJan1,
    xlrOn: !!params.xlrOn,
    avgMonthlyHours: +params.avgMonthlyHours
  });
  const withholdingAudit = [];
  let annualizedWithholdingTax = 0;
  let chequeIndex = 1;
  monthlyBreakdown.monthsGross.forEach((monthGross, idx) => {
    const step = monthlyBreakdown.monthSteps[idx];
    const advanceGross = Math.min(monthGross, advanceGrossForSeatStep(seat, step));
    const secondGross = Math.max(0, monthGross - advanceGross);
    const secondPension = monthGross * pensionRateForStep(step);
    const advanceTax = advanceGross > 0 ? computeChequeTax({
      gross: advanceGross,
      pension: 0,
      year,
      province,
      chequesPerYear: 12
    }) : 0;
    const secondTax = secondGross > 0 ? computeChequeTax({
      gross: secondGross,
      pension: secondPension,
      year,
      province,
      chequesPerYear: 24
    }) : 0;
    annualizedWithholdingTax += advanceTax + secondTax;
    withholdingAudit.push({
      cheque: chequeIndex++,
      month: idx + 1,
      step,
      type: 'Advance',
      gross: advanceGross,
      pension: 0,
      tax: advanceTax
    });
    withholdingAudit.push({
      cheque: chequeIndex++,
      month: idx + 1,
      step,
      type: 'Second',
      gross: secondGross,
      pension: secondPension,
      tax: secondTax
    });
  });
  const tax_return = +((annualizedWithholdingTax - income_tax) + (income_tax - income_tax_rrsp)).toFixed(2);

  return {
    audit,
    gross:+gross.toFixed(2),
    net:+net.toFixed(2),
    tax:+income_tax.toFixed(2),
    // Show CPP/QPP and EI deductions actually applied.
    cpp:+cpp_total_deduct.toFixed(2),
    ei:+eiPrem_deduct.toFixed(2),
    health:+annual_health.toFixed(2),
    pension:+pension.toFixed(2),
    esop:+esop.toFixed(2),
    esop_match_after_tax:+esop_match_net.toFixed(2),
    monthly,
    step_jan1:stepJan1,
    tax_return,
    taxable_pre:+taxable_pre.toFixed(2),
    taxable_rrsp:+taxable_rrsp.toFixed(2),
    income_tax_rrsp:+income_tax_rrsp.toFixed(2),
    annualized_withholding_tax:+annualizedWithholdingTax.toFixed(2),
    union_annual:+union.annual.toFixed(2),
    withholding_audit: withholdingAudit,
    cpp_full:+cpp_total_full.toFixed(2),
    ei_full:+eiPrem_full.toFixed(2)
  };
}

function getTaxDataForYear(year, province){
  const fedData = (year <= 2025 ? FED : FED_2026);
  const provMap = (year <= 2025 ? PROV : PROV_2026);
  const p = provMap[province];
  if (!p) throw new Error('Unsupported province '+province);
  const fedLow = fedData.brackets[0][1];
  const provLow = p.brackets[0][1];
  return { fedData, provData: p, fedLow, provLow };
}

function computeIncomeTaxWithCredits({ taxable, year, province, cpp, ei }){
  const { fedData, provData, fedLow, provLow } = getTaxDataForYear(year, province);
  const fedGross = taxFromBrackets(taxable, fedData.brackets);
  const provGross = taxFromBrackets(taxable, provData.brackets);
  const fedTax = Math.max(0, fedGross - (fedLow * federalBPA(year, taxable) + 0.15 * (cpp + ei)));
  const provTax = Math.max(0, provGross - (provLow * provincialBPA(year, taxable, province) + provLow * (cpp + ei)));
  return { total: fedTax + provTax, fedLow, provLow };
}


// === Standalone paycheque helpers (FIXED LOGIC) ===
function computeChequeTax({ gross, pension, year, province, chequesPerYear = 12 }) {
  const fedData = (year <= 2025 ? FED : FED_2026);
  const provMap = (year <= 2025 ? PROV : PROV_2026);
  const p = provMap[province];
  if (!p) throw new Error('Unsupported province '+province);

  const taxable = Math.max(0, gross - pension);
  const annualized = taxable * chequesPerYear;

  const fedGross = taxFromBrackets(annualized, fedData.brackets);
  const provGross = taxFromBrackets(annualized, p.brackets);

  const fedLow = fedData.brackets[0][1];
  const provLow = p.brackets[0][1];

  const fedTax = Math.max(0, fedGross - fedLow * federalBPA(year, annualized));
  const provTax = Math.max(0, provGross - provLow * provincialBPA(year, annualized, province));

  return (fedTax + provTax) / chequesPerYear;
}

function computeChequeCPP_EI({ year, seat, ac, step, xlrOn, gross, province }) {
  // Convert cheque gross to equivalent monthly hours, then compute CPP/EI on that cheque only
  const rate = rateFor(seat, ac, year, step, !!xlrOn);
  const hours = rate > 0 ? gross / rate : 0;
  const ded = computeCPP_EI_Daily({
    year,
    seat,
    ac,
    stepJan1: step,
    xlrOn: !!xlrOn,
    avgMonthlyHours: hours,
    province
  });
  return { cpp: ded.cpp_total / 12, ei: ded.ei / 12 };
}

// --- VO computation ---
function computeVO(params){
  const seat=params.seat, ac=params.ac, year=+params.year, province=params.province;
  const step = params.tieOn ? stepOnJan1(params.stepInput, true, year) : clampStep(params.stepInput);
  const rate = rateFor(seat, ac, year, step, !!params.xlrOn);
  const credits = Math.max(0, (+params.creditH) + Math.max(0, Math.min(59, +params.creditM))/60);
  const hours = credits * 2;
  const gross = hours * rate;
  const fedData = (year <= 2025 ? FED : FED_2026);
  const provMap = (year <= 2025 ? PROV : PROV_2026);
  const p = provMap[province];
  if (!p) throw new Error('Unsupported province '+province);
  const fed_m = marginalRate(gross, fedData.brackets);
  const prov_m = marginalRate(gross, p.brackets);
  const net = gross*(1-(fed_m+prov_m));
  return {rate,hours,gross,net,fed_m,prov_m,step_used:step};
}

// --- Monthly computation ---
/*
 * Compute a monthly snapshot based on a specific number of credit hours.
 * Credits beyond 85 in a month are paid at double the hourly rate (per contract).
 * This version also calculates a pay advance and second pay split and respects
 * the Maxed CPP/EI option.  TAFB is paid after tax and is included in the
 * second pay by default.
 */
function computeMonthly(params){
  const seat=params.seat, ac=params.ac, year=+params.year, province=params.province;
  // Step on Jan1 if tie enabled; else use provided stepInput
  const step = params.tieOn ? stepOnJan1(params.stepInput, true, year) : clampStep(params.stepInput);
  const rate = rateFor(seat, ac, year, step, !!params.xlrOn);
  const creditHours = Number.isFinite(+params.creditH) ? +params.creditH : +params.credits;
  const creditMinutes = Number.isFinite(+params.creditM) ? +params.creditM : 0;
  const credits = Math.max(0, (+creditHours) + Math.max(0, Math.min(59, +creditMinutes)) / 60);
  const voHoursRaw = Number.isFinite(+params.voCredits) ? +params.voCredits : 0;
  const voMinutesRaw = Number.isFinite(+params.voCreditMinutes)
    ? +params.voCreditMinutes
    : (Number.isFinite(+params.voCreditsMinutes) ? +params.voCreditsMinutes : (Number.isFinite(+params.voMinutes) ? +params.voMinutes : 0));
  const voCredits = Math.max(0, voHoursRaw + Math.max(0, Math.min(59, voMinutesRaw)) / 60);
  // Regular pay hours (<=85), overtime beyond 85, and VO credits (all double time)
  const regHours = Math.min(85, credits);
  const overtime = Math.max(0, credits - 85);
  const gross = regHours * rate + overtime * 2 * rate + voCredits * 2 * rate;
  const fedData = (year <= 2025 ? FED : FED_2026);
  const provMap = (year <= 2025 ? PROV : PROV_2026);
  const p = provMap[province];
  if (!p) throw new Error('Unsupported province '+province);
  // Annualize gross and pension for marginal rate determination
  const annualGrossApprox = gross * 12;
  const pensionRate = pensionRateOnDate(new Date());
  const annualPensionApprox = annualGrossApprox * pensionRate;
  const taxableAnnualApprox = Math.max(0, annualGrossApprox - annualPensionApprox);
  const fed_m = marginalRate(taxableAnnualApprox, fedData.brackets);
  const prov_m = marginalRate(taxableAnnualApprox, p.brackets);
  // Compute monthly income tax using the standalone cheque calculator so that
  // the result aligns with the two‑pay split below.
  const tax = computeChequeTax({ gross, pension: gross * pensionRate, year, province });
  // Approximate CPP/QPP & EI contributions by annualizing and dividing by 12; include VO credits
  const ded = computeCPP_EI_Daily({ year, seat, ac, stepJan1: step, xlrOn: !!params.xlrOn, avgMonthlyHours: credits + voCredits, province });
  const cpp_month = ded.cpp_total / 12;
  const ei_month  = ded.ei / 12;
  // Union dues: use average monthly from annual computation (include VO credits)
  const union = computeUnionDuesMonthly({ year, seat, ac, stepJan1: step, xlrOn: !!params.xlrOn, avgMonthlyHours: credits + voCredits });
  const union_month = union.avgMonthly;
  // Pension: approximate using current pension rate
  const pension = gross * pensionRate;
  const health = HEALTH_MO;
  const esop = Math.min((+params.esopPct/100)*gross, 30000/12);
  const esop_match_after_tax = 0.30 * esop * (1 - (fed_m + prov_m));
  // TAFB: per diem hours times $5.427/hr (paid after tax)
  const tafbHours = Math.max(0, +params.tafb || 0);
  const tafb_net = tafbHours * 5.427;
  // Monthly net (before pay split) subtracts ESOP contributions, pension, health and union dues and
  // adds the employer ESOP match and TAFB.  This represents the money remaining after all
  // deductions (including ESOP contributions) plus the employer match and per diem.
  let net = gross - tax - cpp_month - ei_month - health - union_month - pension - esop + esop_match_after_tax + tafb_net;

  
  // --- Advance & Second Pay split (cheque-based deductions) ---
  let payAdvance = 0, secondPay = 0;
  let advAmt = Math.max(0, +params.adv || 0);
  if (advAmt > gross) advAmt = gross;

  const advTax = advAmt > 0 ? computeChequeTax({ gross: advAmt, pension: 0, year, province, chequesPerYear: 12 }) : 0;
  const advCppEi = params.maxcpp || advAmt === 0 ? { cpp: 0, ei: 0 } : computeChequeCPP_EI({ year, seat, ac, step, xlrOn: !!params.xlrOn, gross: advAmt, province });
  const advCpp = advCppEi.cpp;
  const advEi = advCppEi.ei;

  payAdvance = advAmt - advTax - advCpp - advEi;

  const secondGross = gross - advAmt;
  const secTax = secondGross > 0 ? computeChequeTax({ gross: secondGross, pension, year, province }) : 0;
  const secCppEi = params.maxcpp || secondGross === 0 ? { cpp: 0, ei: 0 } : computeChequeCPP_EI({ year, seat, ac, step, xlrOn: !!params.xlrOn, gross: secondGross, province });
  const secCpp = secCppEi.cpp;
  const secEi = secCppEi.ei;
  secondPay = secondGross - secTax - secCpp - secEi - health - union_month - pension - esop + tafb_net;

  const totalTax = advTax + secTax;
  const totalCpp = advCpp + secCpp;
  const totalEi = advEi + secEi;

  net = gross - totalTax - totalCpp - totalEi - health - union_month - pension - esop + esop_match_after_tax + tafb_net;


  return { rate, credits, voCredits, regHours, overtime, gross, net, tax: totalTax, cpp: totalCpp, ei: totalEi, health, pension, esop, esop_match_after_tax, union: union_month, fed_m, prov_m, tafb_net, step_used: step, pay_advance: payAdvance, second_pay: secondPay };
}

function parseTimeToMinutes(value){
  if (!value) return NaN;
  const parts = String(value).split(':').map(Number);
  if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) return NaN;
  const [hh, mm] = parts;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return NaN;
  return hh * 60 + mm;
}

function formatMinutesToTime(value){
  if (!Number.isFinite(value)) return '--:--';
  const total = ((Math.round(value) % 1440) + 1440) % 1440;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

function formatUtcMinutesWithDayOffset(value){
  if (!Number.isFinite(value)) return '--:--Z';
  const dayOffset = Math.floor(value / 1440);
  const timeLabel = formatMinutesToTime(value);
  const daySuffix = dayOffset === 0 ? '' : ` (${dayOffset > 0 ? `+${dayOffset}` : `${dayOffset}`}d)`;
  return `${timeLabel}Z${daySuffix}`;
}

function formatHoursValue(value){
  const rounded = Math.round(value * 100) / 100;
  if (!Number.isFinite(rounded)) return '--';
  if (Math.abs(rounded % 1) < 1e-9) return String(rounded.toFixed(0));
  return String(rounded.toFixed(2)).replace(/0+$/,'').replace(/\.$/,'');
}

function formatHoursMinutes(value){
  if (!Number.isFinite(value)) return '--';
  const totalMinutes = Math.round(value * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.abs(totalMinutes % 60);
  const hoursLabel = `${hours} hour${hours === 1 ? '' : 's'}`;
  if (!minutes) return hoursLabel;
  return `${hoursLabel} ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function parseDurationToMinutes(value){
  if (!value) return NaN;
  const text = String(value).trim();
  if (!text) return NaN;
  if (text.includes(':')){
    const [hours, minutes] = text.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return NaN;
    return (hours * 60) + minutes;
  }
  const asNumber = Number(text);
  if (!Number.isFinite(asNumber)) return NaN;
  return Math.round(asNumber * 60);
}

function formatDurationMinutes(totalMinutes){
  if (!Number.isFinite(totalMinutes)) return '--:--';
  const safeMinutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(safeMinutes / 60);
  const minutes = safeMinutes % 60;
  return `${hours}:${String(minutes).padStart(2,'0')}`;
}

function normalizeAirportCode(code){
  return String(code || '').trim().toUpperCase();
}

function normalizeCrewType(value){
  if (value === 'basic+1' || value === 'basic+2' || value === '2ca2fo') return value;
  if (String(value) === '1') return 'basic+1';
  if (String(value) === '2') return 'basic+2';
  return null;
}

function crewTypeLabel(value){
  const type = normalizeCrewType(value);
  if (type === 'basic+1') return 'Basic +1 crew';
  if (type === 'basic+2') return 'Basic +2 crew';
  if (type === '2ca2fo') return '2CA 2FO crew';
  return 'Augmented crew';
}

function additionalCrewCount(value){
  const type = normalizeCrewType(value);
  if (type === 'basic+1') return 1;
  if (type === 'basic+2' || type === '2ca2fo') return 2;
  return null;
}

function fomFacilityLabel(value){
  if (value === 1) return 'Class 1 rest facility';
  if (value === 2) return 'Class 2 rest facility';
  if (value === 3) return 'Class 3 rest facility';
  return 'rest facility';
}

function zoneLabel(zone){
  return zone === 'outside' ? 'Outside North American zone' : 'Inside North American zone';
}

function isHomeBaseCode(code){
  const normalized = normalizeAirportCode(code);
  return HOME_BASE_CODES.has(normalized);
}

function computeMaxDuty(params){
  const dutyMode = params.dutyMode === 'fom' ? 'fom' : 'alpa';
  const dutyType = params.dutyType || 'unaugmented';
  if (dutyMode === 'fom'){
    if (dutyType === 'augmented'){
      const additionalCrew = additionalCrewCount(params.crewType);
      const facility = Number(params.restFacility);
      if (!Number.isFinite(additionalCrew) || !Number.isFinite(facility)) {
        throw new Error('Select the crew complement and rest facility class.');
      }
      const match = FOM_AUGMENTED_FDP_TABLE.find(row => row.additionalCrew === additionalCrew && row.facility === facility);
      if (!match) {
        return { maxFdp: null, detail: 'This augmentation/rest facility combination is not listed in the FOM table.' };
      }
      const crewLabel = `${additionalCrew} additional crew member${additionalCrew > 1 ? 's' : ''}`;
      return {
        maxFdp: match.max,
        detail: `FOM augmented FDP: ${crewLabel} with ${fomFacilityLabel(facility)}.`
      };
    }
    const startMinutes = parseTimeToMinutes(params.startTime);
    const startValue = Number.isFinite(params.startMinutes) ? params.startMinutes : startMinutes;
    const sectors = Number(params.sectors);
    if (!Number.isFinite(startValue)) throw new Error('Enter an FDP start time in HH:MM.');
    if (!Number.isFinite(sectors) || sectors < 1 || sectors > 6) throw new Error('Planned sectors must be between 1 and 6.');
    const row = FOM_FDP_TABLE.find(item => startValue >= item.start && startValue <= item.end);
    if (!row) throw new Error('Start time is outside the FOM FDP table range.');
    const maxFdp = sectors <= 4 ? row.max14 : row.max56;
    const sectorLabel = sectors <= 4 ? '1-4 sectors' : '5-6 sectors';
    return {
      maxFdp,
      detail: `FOM unaugmented FDP: ${sectorLabel}, start time ${row.label}.`
    };
  }
  const zone = params.zone === 'outside' ? 'outside' : 'inside';
  const deadhead = params.deadhead === 'yes';
  const tzDiff = Math.abs(Number(params.timezoneDiff));
  const tzOver4 = Number.isFinite(tzDiff) && tzDiff >= 4;
  if (dutyType === 'augmented'){
    const crewType = normalizeCrewType(params.crewType);
    const facility = Number(params.restFacility);
    if (!crewType || !Number.isFinite(facility)) {
      throw new Error('Select the crew complement and rest facility class.');
    }
    const match = AUGMENTED_FDP_TABLE.find(row =>
      row.crew === crewType && row.facility === facility && (row.zone === zone || row.zone === 'any')
    );
    if (!match) {
      return { maxFdp: null, detail: 'This augmentation/rest facility combination is not listed in the table.' };
    }
    const maxFdp = deadhead && Number.isFinite(match.deadhead) ? match.deadhead : match.max;
    const deadheadNote = deadhead ? ' Deadhead at end of duty day applied.' : '';
    const zoneNote = ` ${zoneLabel(zone)}.`;
    return {
      maxFdp,
      detail: `ALPA ${crewTypeLabel(crewType)} with ${match.facilityLabel}.${zoneNote}${deadheadNote}`
    };
  }
  const startMinutes = parseTimeToMinutes(params.startTime);
  const startValue = Number.isFinite(params.startMinutes) ? params.startMinutes : startMinutes;
  const sectors = Number(params.sectors);
  if (!Number.isFinite(startValue)) throw new Error('Enter an FDP start time in HH:MM.');
  if (!Number.isFinite(sectors) || sectors < 1 || sectors > 6) throw new Error('Planned sectors must be between 1 and 6.');
  if (zone === 'outside' && sectors > 2) throw new Error('Outside North American zone maximum planned legs is 2.');
  const row = (zone === 'outside' ? FDP_MAX_TABLE_OUTSIDE : FDP_MAX_TABLE)
    .find(item => startValue >= item.start && startValue <= item.end);
  if (!row) throw new Error('Start time is outside the FDP table range.');
  if (!Number.isFinite(tzDiff) || tzDiff < 0) throw new Error('Time zone difference must be zero or greater.');
  const baseMax = zone === 'outside'
    ? row.max
    : (sectors <= 4
      ? (tzOver4 ? row.max14Over4 : row.max14)
      : (tzOver4 ? row.max56Over4 : row.max56));
  const maxFdp = zone === 'outside'
    ? (deadhead ? row.deadhead : row.max)
    : (deadhead ? Math.min(baseMax + 3, 18) : baseMax);
  const sectorLabel = zone === 'outside'
    ? `${sectors} leg${sectors > 1 ? 's' : ''}`
    : (sectors <= 4 ? '1-4 sectors' : '5-6 sectors');
  const conversionNote = params.conversionNote ? ` ${params.conversionNote}` : '';
  const zoneNote = zone === 'outside' ? ' Table B (outside North American zone).' : ' Table A (inside North American zone).';
  const tzNote = Number.isFinite(tzDiff)
    ? ` Time zone difference ${formatHoursValue(tzDiff)} hrs (${tzOver4 ? '≥4' : '<4'} column).`
    : '';
  const deadheadNote = deadhead && zone === 'inside'
    ? ' Deadhead at end of duty day adds up to 3 hours (cap 18).'
    : (deadhead && zone === 'outside' ? ' Deadhead at end of duty day (Table D) applied.' : '');
  return {
    maxFdp,
    detail: `ALPA unaugmented FDP, ${sectorLabel}, start time ${row.label} (YYZ local).${zoneNote}${tzNote}${deadheadNote}${conversionNote}`
  };
}

function computeRestRequirement(params){
  const dutyType = params.dutyType || 'unaugmented';
  const endsHome = params.endsHome === 'home';
  const fdpDuration = Number(params.fdpDuration);
  const tzDiff = Math.abs(Number(params.timezoneDiff));
  const awayHours = Number(params.awayHours);
  const encroachWOCL = params.encroachWOCL === 'yes';
  const disruptive = params.disruptive === 'yes';
  const uocOver = Number(params.uocOver);

  if (!Number.isFinite(fdpDuration) || fdpDuration < 0) throw new Error('FDP duration must be zero or greater.');
  if (!Number.isFinite(tzDiff) || tzDiff < 0) throw new Error('Time zone difference must be zero or greater.');
  if (!Number.isFinite(awayHours) || awayHours < 0) throw new Error('Time away from home base must be zero or greater.');
  if (!Number.isFinite(uocOver) || uocOver < 0) throw new Error('UOC overage must be zero or greater.');

  let baseHours = null;
  let baseNights = null;
  let basis = '';

  if (dutyType === 'augmented'){
    const minBase = endsHome ? 16 : 14;
    baseHours = Math.max(fdpDuration, minBase);
    basis = `Augmented FDP rest: max of FDP duration and ${minBase} hours${endsHome ? ' when ending at home base' : ''}.`;
  } else if (endsHome){
    if (tzDiff < 4 || awayHours <= 36){
      baseHours = 12;
      basis = 'Normal rest at home base: 12 hours total or 10 hours in suitable accommodation.';
    } else if (tzDiff === 4){
      baseHours = 13;
      basis = 'Home base return with a 4-hour time zone difference and >36 hours away.';
    } else if (tzDiff > 4 && tzDiff <= 10){
      baseNights = (awayHours <= 60 && !encroachWOCL) ? 1 : 2;
      basis = 'Home base return with >4 to 10 hours time zone difference.';
    } else if (tzDiff > 10){
      baseNights = awayHours <= 60 ? 2 : 3;
      basis = 'Home base return with >10 hours time zone difference.';
    }
  } else {
    if (tzDiff < 4){
      baseHours = 10;
      basis = 'Normal rest away from home base (<4 hour time zone difference).';
    } else if (tzDiff === 4){
      baseHours = 11;
      basis = 'Away from home base with a 4-hour time zone difference.';
    } else {
      baseHours = 14;
      basis = 'Away from home base with >4 hour time zone difference.';
    }
  }

  if (baseHours === null && baseNights === null){
    throw new Error('Unable to determine rest requirement from the provided inputs.');
  }

  const notes = [];
  if (dutyType === 'unaugmented' && disruptive){
    notes.push('Disruptive schedule requires a local night’s rest in addition to the minimum rest.');
  }

  let minimumText = '';
  if (baseNights !== null){
    minimumText = `${baseNights} local night${baseNights > 1 ? 's' : ''} rest`;
    if (uocOver > 0){
      notes.push(`UOC adds at least ${formatHoursValue(uocOver)} hours in addition to the local night’s rest.`);
    }
  } else {
    let minHours = baseHours;
    if (uocOver > 0){
      minHours += uocOver;
      notes.push(`UOC adds ${formatHoursValue(uocOver)} hours to the minimum rest.`);
    }
    minimumText = `${formatHoursValue(minHours)} hours`;
  }

  return { minimumText, basis, notes };
}

// --- UI helpers ---
function updateAircraftOptions(seatValue, selectEl){
  if (!selectEl) return;
  const allowed = (seatValue === 'RP') ? ["777","787","330"] : AIRCRAFT_ORDER.slice();
  const current = selectEl.value;
  selectEl.innerHTML = '';
  allowed.forEach(ac => {
    const opt=document.createElement('option'); opt.textContent=ac; selectEl.appendChild(opt);
  });
  if (allowed.includes(current)) {
    selectEl.value = current;
  } else if (allowed.includes('320')) {
    selectEl.value='320';
  }
}

function isWidebodyType(type){
  return /^(B767|777|787|A330)/.test(type);
}

function normalizeFinState(raw){
  if (!raw) return { items: [], updatedAt: 0 };
  if (Array.isArray(raw)) return { items: expandFinConfigList(raw.map(normalizeFinConfig).filter(Boolean)), updatedAt: 0 };
  if (typeof raw !== 'object') return { items: [], updatedAt: 0 };
  const items = Array.isArray(raw.items)
    ? expandFinConfigList(raw.items.map(normalizeFinConfig).filter(Boolean))
    : [];
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
  return { items, updatedAt };
}

function loadFinExportSettings(){
  try{
    const raw = localStorage.getItem(FIN_EXPORT_SETTINGS_KEY);
    if (!raw) return { owner: '', repo: '', baseBranch: 'main', token: '' };
    const parsed = JSON.parse(raw);
    return {
      owner: String(parsed.owner ?? '').trim(),
      repo: String(parsed.repo ?? '').trim(),
      baseBranch: String(parsed.baseBranch ?? 'main').trim() || 'main',
      token: String(parsed.token ?? '').trim()
    };
  } catch (err){
    console.warn('Failed to load fin export settings', err);
    return { owner: '', repo: '', baseBranch: 'main', token: '' };
  }
}

function saveFinExportSettings(settings){
  try{
    localStorage.setItem(FIN_EXPORT_SETTINGS_KEY, JSON.stringify(settings));
  } catch (err){
    console.warn('Failed to save fin export settings', err);
  }
}

function purgeLegacyFinSyncSettings(){
  try {
    localStorage.removeItem(LEGACY_FIN_SYNC_SETTINGS_KEY);
  } catch (err){
    console.warn('Failed to clear legacy fin sync settings', err);
  }
}

function loadCustomFinState(){
  try {
    const raw = localStorage.getItem(FIN_CUSTOM_STORAGE_KEY);
    if (!raw) return { items: [], updatedAt: 0 };
    const parsed = JSON.parse(raw);
    return normalizeFinState(parsed);
  } catch (err){
    console.warn('Failed to load custom fin configs', err);
    return { items: [], updatedAt: 0 };
  }
}

let customFinState = loadCustomFinState();
let customFinConfigs = customFinState.items.slice();

function persistCustomFinState(state){
  customFinState = state;
  customFinConfigs = state.items.slice();
  try {
    localStorage.setItem(FIN_CUSTOM_STORAGE_KEY, JSON.stringify(state));
  } catch (err){
    console.warn('Failed to save custom fin configs', err);
  }
}

function saveCustomFinConfigs(next){
  const state = { items: next, updatedAt: Date.now() };
  persistCustomFinState(state);
}

function normalizeFinConfig(config){
  if (!config) return null;
  const finStart = Number(config.finStart);
  const finEndRaw = Number(config.finEnd);
  const finEnd = Number.isFinite(finEndRaw) ? finEndRaw : finStart;
  if (!Number.isFinite(finStart) || !Number.isFinite(finEnd)) return null;
  const deleted = config.deleted === true;
  const type = String(config.type ?? '').trim();
  if (deleted){
    return { finStart, finEnd, deleted: true, type };
  }
  const j = Number(config.j);
  const o = Number(config.o);
  const y = Number(config.y);
  const fdjs = Number(config.fdjs);
  const ofcr = Number(config.ofcr);
  const ccjs = Number(config.ccjs);
  const reg = normalizeRegistration(config.reg);
  const notesRaw = typeof config.notes === 'string' ? config.notes : '';
  const notes = notesRaw.trim();
  if (!type) return null;
  const numbers = [j, o, y, fdjs, ofcr, ccjs];
  if (numbers.some(n => !Number.isFinite(n))) return null;
  return { type, finStart, finEnd, j, o, y, fdjs, ofcr, ccjs, reg, notes, deleted: false };
}

function getFinConfigs(){
  return mergeFinConfigs(FIN_CONFIGS, customFinConfigs);
}

function findCustomFinConfig(fin){
  if (!Number.isFinite(fin)) return null;
  return customFinConfigs.find(row => fin >= row.finStart && fin <= row.finEnd) || null;
}

function findFinConfig(fin){
  if (!Number.isFinite(fin)) return null;
  return getFinConfigs().find(row => fin >= row.finStart && fin <= row.finEnd) || null;
}
function findFinByRegistration(reg){
  const normalized = normalizeRegistration(reg);
  if (!normalized) return null;
  const match = getFinConfigs().find(row => normalizeRegistration(row.reg) === normalized);
  if (!match) return null;
  return { fin: match.finStart, config: match };
}

function finConfigsEqual(a, b){
  if (!a || !b) return false;
  if (!!a.deleted !== !!b.deleted) return false;
  if (a.deleted && b.deleted){
    return a.finStart === b.finStart && a.finEnd === b.finEnd && String(a.type ?? '') === String(b.type ?? '');
  }
  const fields = ['type','finStart','finEnd','j','o','y','fdjs','ofcr','ccjs','reg','notes'];
  return fields.every(key => String(a[key] ?? '') === String(b[key] ?? ''));
}

function finRangesOverlap(a, b){
  return a.finStart <= b.finEnd && b.finStart <= a.finEnd;
}

function subtractFinRange(base, removal){
  if (!finRangesOverlap(base, removal)) return [base];
  const segments = [];
  if (removal.finStart > base.finStart){
    segments.push({ finStart: base.finStart, finEnd: Math.min(removal.finStart - 1, base.finEnd) });
  }
  if (removal.finEnd < base.finEnd){
    segments.push({ finStart: Math.max(removal.finEnd + 1, base.finStart), finEnd: base.finEnd });
  }
  return segments.filter(seg => seg.finStart <= seg.finEnd);
}

function mergeFinConfigs(coreConfigs, customConfigs){
  const additions = [];
  const deletions = [];
  customConfigs.forEach(custom => {
    const normalized = normalizeFinConfig(custom);
    if (!normalized) return;
    if (normalized.deleted){
      deletions.push(normalized);
    } else {
      additions.push(normalized);
    }
  });
  let base = coreConfigs.map(row => ({ ...row }));
  if (deletions.length){
    const reduced = [];
    base.forEach(row => {
      let segments = [{ finStart: row.finStart, finEnd: row.finEnd }];
      deletions.forEach(del => {
        segments = segments.flatMap(seg => subtractFinRange(seg, del));
      });
      segments.forEach(seg => reduced.push({ ...row, finStart: seg.finStart, finEnd: seg.finEnd }));
    });
    base = reduced;
  }
  const merged = [...base];
  additions.forEach(custom => {
    for (let i = merged.length - 1; i >= 0; i -= 1){
      if (finRangesOverlap(custom, merged[i])){
        merged.splice(i, 1);
      }
    }
    merged.push(custom);
  });
  merged.sort((a, b) => a.finStart - b.finStart);
  return merged;
}

function computeCustomFinDifferences(){
  const diffs = [];
  customFinConfigs.forEach(custom => {
    const normalized = normalizeFinConfig(custom);
    if (!normalized) return;
    const baseMatch = FIN_CONFIGS.find(row => finRangesOverlap(row, normalized));
    const exactMatch = FIN_CONFIGS.find(row => row.finStart === normalized.finStart && row.finEnd === normalized.finEnd);
    if (normalized.deleted){
      diffs.push({ ...normalized, type: normalized.type || baseMatch?.type || 'Fin' });
      return;
    }
    if (!exactMatch || !finConfigsEqual(exactMatch, normalized)){
      diffs.push(normalized);
    }
  });
  return diffs;
}

function formatFinConfigForSource(row){
  const esc = (val) => String(val ?? '').replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/\n/g, '\\n');
  const fields = [
    `type: '${esc(row.type)}'`,
    `finStart: ${row.finStart}`,
    `finEnd: ${row.finEnd}`,
    `j: ${row.j}`,
    `o: ${row.o}`,
    `y: ${row.y}`,
    `fdjs: ${row.fdjs}`,
    `ofcr: ${row.ofcr}`,
    `ccjs: ${row.ccjs}`
  ];
  if (row.reg){
    fields.push(`reg: '${esc(row.reg)}'`);
  }
  if (row.notes){
    fields.push(`notes: '${esc(row.notes)}'`);
  }
  return `  { ${fields.join(', ')} }`;
}

function findClosingBracket(source, openIndex){
  let depth = 0;
  let inString = false;
  let stringChar = '';
  for (let i = openIndex; i < source.length; i += 1){
    const ch = source[i];
    const prev = source[i - 1];
    if (inString){
      if (ch === stringChar && prev !== '\\'){
        inString = false;
        stringChar = '';
      }
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`'){
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '[') depth += 1;
    if (ch === ']'){
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function replaceFinConfigBlock(source, configs){
  const markerPattern = /^const\s+FIN_CONFIGS\s*=\s*[^[]*\[/m;
  const match = source.match(markerPattern);
  if (!match) throw new Error('FIN_CONFIGS block not found');
  const openIndex = source.indexOf('[', match.index);
  if (openIndex === -1) throw new Error('FIN_CONFIGS block not found');
  const closeIndex = findClosingBracket(source, openIndex);
  if (closeIndex === -1) throw new Error('FIN_CONFIGS block termination not found');
  const before = source.slice(0, openIndex);
  const after = source.slice(closeIndex);
  const body = configs.map(formatFinConfigForSource).join(',\n');
  return `${before}[\n${body}\n${after}`;
}

function bumpCacheVersion(content){
  const match = content.match(/const\s+CACHE\s*=\s*'([^']+)'/);
  if (!match) return content;
  const current = match[1];
  const next = current.replace(/(v)(\d+)$/i, (_, v, num) => `${v}${Number(num) + 1}`);
  const updated = (next === current) ? `${current}-${Date.now()}` : next;
  return content.replace(match[0], `const CACHE = '${updated}'`);
}

async function githubJson(path, { method = 'GET', token, body } = {}){
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    body
  });
  const text = await resp.text();
  if (!resp.ok){
    let message = text || resp.statusText;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || message;
    } catch (err){ /* ignore */ }
    throw new Error(`GitHub API ${resp.status}: ${message}`);
  }
  return text ? JSON.parse(text) : null;
}

async function fetchGitHubFileContent({ owner, repo, ref, path, token }){
  const json = await githubJson(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`, { token });
  const content = json?.content ? atob(json.content.replace(/\n/g, '')) : '';
  return { text: content, sha: json.sha };
}

async function putGitHubFileContent({ owner, repo, branch, path, token, message, content, sha }){
  const payload = {
    message,
    content: btoa(content),
    branch,
    sha
  };
  return githubJson(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    token,
    body: JSON.stringify(payload)
  });
}

async function ensureFinExportSettings(){
  const current = loadFinExportSettings();
  const hasRepo = Boolean(current.owner && current.repo);
  const hasBranch = Boolean(current.baseBranch);
  const hasToken = Boolean(current.token);
  if (hasRepo && hasBranch && hasToken){
    return current;
  }
  let owner = current.owner;
  let repo = current.repo;
  let baseBranch = current.baseBranch || 'main';
  let token = current.token;
  if (!hasRepo){
    const repoPrompt = prompt('GitHub repo (owner/name)', current.owner && current.repo ? `${current.owner}/${current.repo}` : '');
    if (!repoPrompt) return null;
    const [ownerInput, repoInput] = repoPrompt.split('/').map(part => String(part ?? '').trim());
    if (!ownerInput || !repoInput) return null;
    owner = ownerInput;
    repo = repoInput;
  }
  if (!hasBranch){
    baseBranch = prompt('Base branch', baseBranch || 'main') || 'main';
  }
  if (!hasToken){
    token = prompt('GitHub token (repo scope)', token || '');
    if (!token) return null;
  }
  const settings = { owner, repo, baseBranch, token };
  saveFinExportSettings(settings);
  return settings;
}

function buildFinPrBody(diffs){
  const lines = ['Automated fin export from AC Pay.', '', 'Changes:', ''];
  diffs.forEach(row => {
    if (row.deleted){
      const typeLabel = row.type ? `${row.type} ` : '';
      lines.push(`- Removed ${typeLabel}fin ${finRangeLabel(row)}`);
      return;
    }
    lines.push(`- ${row.type} ${finRangeLabel(row)} (J/O/Y ${row.j}/${row.o}/${row.y}, FDJS ${row.fdjs}, OFCR ${row.ofcr}, CCJS ${row.ccjs})${row.notes ? ` — ${row.notes}` : ''}`);
  });
  return lines.join('\n');
}

function detectClientPlatform(){
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const maxTouchPoints = navigator.maxTouchPoints || 0;
  const isIos = /iP(hone|od|ad)/i.test(platform)
    || /iPhone|iPad|iPod/i.test(ua)
    || (platform === 'MacIntel' && maxTouchPoints > 1);
  const isMac = /Macintosh|Mac OS X/i.test(ua) && !isIos;
  return { isIos, isMac };
}

function openGitHubPrDestination(url){
  if (!url) return;
  const { isIos, isMac } = detectClientPlatform();
  if (isIos){
    window.location.href = url; // iOS will hand off to the GitHub app if installed
    return;
  }
  const win = window.open(url, '_blank', isMac ? 'noopener,noreferrer' : undefined);
  if (!win){
    window.location.href = url;
  }
}

async function exportFinConfigsToGitHub({ statusId }){
  const statusEl = document.getElementById(statusId);
  const setStatus = (msg, isError=false) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('wx-error', isError);
  };
  const diffs = computeCustomFinDifferences();
  if (!diffs.length){
    setStatus('No custom fin changes to export.');
    return;
  }
  setStatus('Collecting GitHub details...');
  const settings = await ensureFinExportSettings();
  if (!settings){
    setStatus('Export cancelled.');
    return;
  }
  try{
    setStatus('Preparing branch...');
    const baseRef = await githubJson(`/repos/${settings.owner}/${settings.repo}/git/ref/heads/${encodeURIComponent(settings.baseBranch)}`, { token: settings.token });
    const baseSha = baseRef?.object?.sha;
    if (!baseSha) throw new Error('Base branch not found.');
    let branchName = `fin-export-${Date.now()}`;
    try {
      await githubJson(`/repos/${settings.owner}/${settings.repo}/git/refs`, {
        method: 'POST',
        token: settings.token,
        body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha })
      });
    } catch (err){
      branchName = `fin-export-${Date.now()}-${Math.floor(Math.random()*1000)}`;
      await githubJson(`/repos/${settings.owner}/${settings.repo}/git/refs`, {
        method: 'POST',
        token: settings.token,
        body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha })
      });
    }
    setStatus('Fetching source files...');
    const appFile = await fetchGitHubFileContent({
      owner: settings.owner,
      repo: settings.repo,
      ref: settings.baseBranch,
      path: 'app.js',
      token: settings.token
    });
    const swFile = await fetchGitHubFileContent({
      owner: settings.owner,
      repo: settings.repo,
      ref: settings.baseBranch,
      path: 'sw.js',
      token: settings.token
    });
    const merged = mergeFinConfigs(FIN_CONFIGS, customFinConfigs);
    const updatedApp = replaceFinConfigBlock(appFile.text, merged);
    const updatedSw = bumpCacheVersion(swFile.text);
    setStatus('Pushing changes...');
    await putGitHubFileContent({
      owner: settings.owner,
      repo: settings.repo,
      branch: branchName,
      path: 'app.js',
      token: settings.token,
      message: 'Export fin updates from AC Pay',
      content: updatedApp,
      sha: appFile.sha
    });
    await putGitHubFileContent({
      owner: settings.owner,
      repo: settings.repo,
      branch: branchName,
      path: 'sw.js',
      token: settings.token,
      message: 'Bump cache version for fin export',
      content: updatedSw,
      sha: swFile.sha
    });
    setStatus('Creating pull request...');
    const pr = await githubJson(`/repos/${settings.owner}/${settings.repo}/pulls`, {
      method: 'POST',
      token: settings.token,
      body: JSON.stringify({
        title: `Export fin updates (${diffs.length} change${diffs.length === 1 ? '' : 's'})`,
        head: branchName,
        base: settings.baseBranch,
        body: buildFinPrBody(diffs)
      })
    });
    const url = pr?.html_url;
    setStatus(url ? `Pull request created: ${url}` : 'Pull request created.');
    if (url) openGitHubPrDestination(url);
  } catch (err){
    setStatus(`Export failed: ${err.message}`, true);
  }
}

function finRangeLabel(row){
  return row.finStart === row.finEnd ? `${row.finStart}` : `${row.finStart}-${row.finEnd}`;
}

function escapeHtml(value){
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function finFormValuesFromRow(row, fin){
  return {
    type: row?.type ?? '',
    finStart: Number.isFinite(row?.finStart) ? row.finStart : fin,
    j: Number.isFinite(row?.j) ? row.j : 0,
    o: Number.isFinite(row?.o) ? row.o : 0,
    y: Number.isFinite(row?.y) ? row.y : 0,
    fdjs: Number.isFinite(row?.fdjs) ? row.fdjs : 0,
    ofcr: Number.isFinite(row?.ofcr) ? row.ofcr : 0,
    ccjs: Number.isFinite(row?.ccjs) ? row.ccjs : 0,
    reg: normalizeRegistration(row?.reg),
    notes: typeof row?.notes === 'string' ? row.notes : ''
  };
}

function renderFinForm(values){
  return `
    <div class="fin-form hidden" data-fin-form>
      <div class="fin-form-grid">
        <div>
          <label>Aircraft type</label>
          <input type="text" inputmode="text" data-fin-field="type" value="${escapeHtml(values.type)}">
        </div>
        <div>
          <label>Reg.</label>
          <input type="text" inputmode="text" autocapitalize="characters" data-fin-field="reg" value="${escapeHtml(values.reg)}" placeholder="e.g., C-FIVS">
        </div>
        <div>
          <label>Fin number</label>
          <input type="number" min="1" inputmode="numeric" data-fin-field="finStart" value="${values.finStart}">
        </div>
        <div>
          <label>J seats</label>
          <input type="number" min="0" inputmode="numeric" data-fin-field="j" value="${values.j}">
        </div>
        <div>
          <label>O seats</label>
          <input type="number" min="0" inputmode="numeric" data-fin-field="o" value="${values.o}">
        </div>
        <div>
          <label>Y seats</label>
          <input type="number" min="0" inputmode="numeric" data-fin-field="y" value="${values.y}">
        </div>
        <div>
          <label>FD jumps</label>
          <input type="number" min="0" inputmode="numeric" data-fin-field="fdjs" value="${values.fdjs}">
        </div>
        <div>
          <label>Bunks</label>
          <input type="number" min="0" inputmode="numeric" data-fin-field="ofcr" value="${values.ofcr}">
        </div>
        <div>
          <label>Cabin jumps</label>
          <input type="number" min="0" inputmode="numeric" data-fin-field="ccjs" value="${values.ccjs}">
        </div>
        <div class="fin-notes-field">
          <label>Notes (optional)</label>
          <textarea data-fin-field="notes" rows="3" maxlength="2000" placeholder="Add reference info or reminders for this fin">${escapeHtml(values.notes)}</textarea>
        </div>
      </div>
      <div class="fin-form-actions">
        <button type="button" class="btn" data-fin-action="save">Save fin</button>
      </div>
      <div class="wx-error hidden" data-fin-error></div>
    </div>
  `;
}

function renderFinSeatInputs(values){
  return `
    <div class="fin-seat-inputs">
      <label>
        <span class="fin-seat-label">J</span>
        <input type="number" min="0" inputmode="numeric" data-fin-field="j" value="${values.j}">
      </label>
      <label>
        <span class="fin-seat-label">O</span>
        <input type="number" min="0" inputmode="numeric" data-fin-field="o" value="${values.o}">
      </label>
      <label>
        <span class="fin-seat-label">Y</span>
        <input type="number" min="0" inputmode="numeric" data-fin-field="y" value="${values.y}">
      </label>
    </div>
  `;
}

function renderFinCard({ label, display, edit, editOnly = false }){
  return `
    <div class="metric-card fin-card ${editOnly ? 'fin-edit-only' : ''}">
      <div class="metric-label">${label}</div>
      <div class="metric-value fin-field-display">${display}</div>
      <div class="fin-field-edit">
        ${edit}
      </div>
    </div>
  `;
}

function formatLocalDateTime(ts){
  if (!Number.isFinite(ts)) return '—';
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function deriveFr24LiveStatus(entry, departureTime, arrivalTime){
  const statusText = String(entry?.status ?? entry?.flight_status ?? entry?.flightstatus ?? '').toLowerCase();
  const compact = statusText.replace(/[\s_-]+/g, '');
  const ended = entry?.flight_ended === true || statusText.includes('landed') || statusText.includes('arrived');
  if (ended) return 'completed';
  const alt = Number(entry?.alt ?? entry?.altitude ?? entry?.altitude_baro);
  const gs = Number(entry?.gspeed ?? entry?.groundspeed ?? entry?.speed ?? entry?.velocity);
  if (compact.includes('active') || compact.includes('enroute') || compact.includes('inair')) return 'active';
  if ((Number.isFinite(alt) && alt > 0) || (Number.isFinite(gs) && gs > 50)) return 'active';
  if (entry?.flight_ended === false) return 'active';
  if (Number.isFinite(departureTime) && Number.isFinite(arrivalTime)) return 'completed';
  return 'planned';
}

function mapFr24Airport(airport){
  if (!airport || typeof airport !== 'object') return { code: null, icao: null, iata: null, name: null, city: null };
  const pickNumber = (...values) => {
    for (const value of values){
      if (value === null || value === undefined) continue;
      const num = Number(value);
      if (Number.isFinite(num)) return num;
    }
    return null;
  };
  const iataRaw = airport.iata || airport.iata_code || airport.airport_iata || airport.code_iata || airport.iata_code_limited;
  const iata = typeof iataRaw === 'string' ? iataRaw.trim().toUpperCase() : '';
  const icao = normalizeRegistration(
    airport.icao
    || airport.icao_code
    || airport.airport_icao
    || airport.code_icao
    || airport.code
  );
  const fallback = typeof airport.code === 'string' ? airport.code.trim() : '';
  return {
    code: icao || iata || fallback || null,
    icao: icao || null,
    iata: iata || null,
    name: typeof airport.name === 'string' ? airport.name : null,
    city: typeof airport.city === 'string' ? airport.city : null,
    lat: pickNumber(
      airport.lat,
      airport.latitude,
      airport.lat_deg,
      airport.airport_lat,
      airport.position?.lat,
      airport.position?.latitude,
      airport.position?.lat_deg,
      airport.location?.lat,
      airport.location?.latitude,
      airport.location?.lat_deg,
      airport.geo?.lat,
      airport.geo?.latitude
    ),
    lon: pickNumber(
      airport.lon,
      airport.lng,
      airport.longitude,
      airport.long_deg,
      airport.airport_lon,
      airport.position?.lon,
      airport.position?.lng,
      airport.position?.longitude,
      airport.position?.long_deg,
      airport.location?.lon,
      airport.location?.lng,
      airport.location?.longitude,
      airport.geo?.lon,
      airport.geo?.lng,
      airport.geo?.longitude
    )
  };
}

function formatAirportCode(airport, mode = finAirportCodeMode){
  if (!airport) return '—';
  const preferred = mode === 'iata' ? (airport.iata || airport.icao || airport.code) : (airport.icao || airport.iata || airport.code);
  return preferred || '—';
}

function formatFinRoute(flight, mode = finAirportCodeMode){
  const dep = formatAirportCode(flight?.departure, mode);
  const arr = formatAirportCode(flight?.arrival, mode);
  return `${dep} → ${arr}`;
}

function sortFlightsByRecency(flights){
  const copy = Array.isArray(flights) ? [...flights] : [];
  return copy.sort((a, b) => {
    const aTime = Number.isFinite(a?.arrivalTime) ? a.arrivalTime : a?.departureTime ?? 0;
    const bTime = Number.isFinite(b?.arrivalTime) ? b.arrivalTime : b?.departureTime ?? 0;
    return bTime - aTime;
  });
}

function buildFinLocationSnapshot(flights){
  const sorted = sortFlightsByRecency(flights);
  const active = sorted.find((flight) => flight.status === 'active') || null;
  const current = active || sorted[0] || null;
  const airport = current
    ? (current.status === 'planned'
      ? (current.departure || current.arrival || null)
      : (current.arrival || current.departure || null))
    : null;
  return {
    flights: sorted,
    currentFlight: current,
    inflight: current?.status === 'active',
    airport
  };
}

function mapFr24LiveSummaryFlight(entry){
  if (!entry) return null;
  const departure = mapFr24Airport({
    icao: entry.orig_icao,
    iata: entry.orig_iata
  });
  const arrival = mapFr24Airport({
    icao: entry.dest_icao_actual || entry.dest_icao,
    iata: entry.dest_iata_actual || entry.dest_iata
  });
  const departureTime = parseFr24Date(entry.orig_time ?? entry.datetime_takeoff ?? entry.departure_time);
  const arrivalTime = parseFr24Date(entry.dest_time ?? entry.datetime_landed ?? entry.arrival_time);
  const estimatedArrivalTime = parseFr24Date(entry.eta ?? entry.estimated_arrival ?? entry.estimated_arrival_time);
  const status = deriveFr24LiveStatus(entry, departureTime, arrivalTime);
  const flightNumber = entry.callsign || entry.call_sign || entry.flight || entry.flight_number || '';
  const registration = normalizeRegistration(entry.reg || entry.registration || entry.aircraft_registration);
  const icao24 = normalizeRegistration(entry.hex || entry.icao24 || entry.mode_s);
  if (!departure.code && !arrival.code && departureTime === null && arrivalTime === null && !flightNumber) return null;
  return {
    departure,
    arrival,
    departureTime: departureTime ?? null,
    arrivalTime: arrivalTime ?? null,
    estimatedArrivalTime: estimatedArrivalTime ?? null,
    status,
    flightNumber: flightNumber || null,
    registration,
    icao24
  };
}

function mapFr24FullSummaryFlight(entry){
  if (!entry) return null;
  const departure = mapFr24Airport(entry?.airport?.origin || entry?.airport?.departure || {
    icao: entry.orig_icao,
    iata: entry.orig_iata
  });
  const arrival = mapFr24Airport(entry?.airport?.destination || entry?.airport?.arrival || entry?.airport?.destination_airport || {
    icao: entry.dest_icao_actual || entry.dest_icao,
    iata: entry.dest_iata_actual || entry.dest_iata
  });
  const estimatedArrivalTime = parseFr24Date(
    entry.estimated_arrival
    ?? entry.estimated_arrival_time
    ?? entry.estimated_arrival_utc
    ?? entry.arrival_time
    ?? entry.arrival?.estimated?.utc
    ?? entry.arrival?.estimated
    ?? entry.arrival?.time?.estimated
  );
  const departureTime = parseFr24Date(entry.first_seen ?? entry.datetime_takeoff);
  const arrivalTime = parseFr24Date(entry.last_seen ?? entry.datetime_landed ?? entry.datetime_arrival);
  const status = deriveFr24FlightStatus(entry, departureTime, arrivalTime);
  const flightNumber = entry.callsign || entry.call_sign || entry.flight || entry.flight_number || '';
  const registration = normalizeRegistration(entry.reg || entry.registration || entry.aircraft_registration);
  const icao24 = normalizeRegistration(entry.hex || entry.icao24 || entry.mode_s);
  if (!departure.code && !arrival.code && departureTime === null && arrivalTime === null && !flightNumber) return null;
  return {
    departure,
    arrival,
    departureTime: departureTime ?? null,
    arrivalTime: arrivalTime ?? null,
    estimatedArrivalTime: estimatedArrivalTime ?? null,
    status,
    flightNumber: flightNumber || null,
    registration,
    icao24
  };
}

function describeFr24Status(status){
  if (status === 'active') return 'Active flight';
  if (status === 'completed') return 'Completed flight';
  return 'Planned flight';
}

function renderFinSummaryRow(flight){
  const route = formatFinRoute(flight);
  const status = describeFr24Status(flight.status);
  const times = [
    flight.departureTime ? `Dep ${formatLocalDateTime(flight.departureTime)}` : null,
    flight.arrivalTime ? `Arr ${formatLocalDateTime(flight.arrivalTime)}` : null
  ].filter(Boolean).join(' • ');
  const meta = [status, flight.flightNumber, flight.registration || flight.icao24].filter(Boolean).join(' • ');
  return `
    <div class="fin-summary-row">
      <div class="metric-value">${escapeHtml(route)}</div>
      <div class="muted-note">${escapeHtml(meta || 'No flight metadata available')}</div>
      <div class="muted-note">${escapeHtml(times || 'Times unavailable')}</div>
    </div>
  `;
}

function cacheFinFlights(registration, flights){
  const sorted = sortFlightsByRecency(flights);
  FIN_FLIGHT_CACHE.set(registration, { flights: sorted, fetchedAt: Date.now() });
  return sorted;
}

function renderFinFlightList(container, flights, { hideActive = false } = {}){
  if (!container) return;
  const list = Array.isArray(flights) ? flights : [];
  const visible = hideActive ? list.filter((flight) => flight.status !== 'active') : list;
  if (!visible.length){
    container.innerHTML = '<div class="muted-note">No recent flights.</div>';
    return;
  }
  container.innerHTML = visible.map(renderFinSummaryRow).join('');
}

function renderFinCurrentFlight(container, snapshot){
  if (!container) return;
  if (!snapshot.currentFlight){
    container.innerHTML = '<div class="muted-note">No flights available for this fin.</div>';
    return;
  }
  if (!snapshot.inflight){
    container.innerHTML = '<div class="muted-note">Not currently in flight. Most recent flights below.</div>';
    return;
  }
  const current = snapshot.currentFlight;
  const title = snapshot.inflight ? 'In Flight' : describeFr24Status(current.status);
  const route = formatFinRoute(current);
  const meta = [current.flightNumber, current.registration || current.icao24].filter(Boolean).join(' • ');
  const times = [
    current.departureTime ? `Dep ${formatLocalDateTime(current.departureTime)}` : null,
    current.arrivalTime ? `Arr ${formatLocalDateTime(current.arrivalTime)}` : null
  ].filter(Boolean).join(' • ');
  container.innerHTML = `
    <div class="metric-label">${escapeHtml(title)}</div>
    <div class="metric-value">${escapeHtml(route)}</div>
    <div class="fin-flight-meta">${escapeHtml(meta || 'No identifiers available')}</div>
    <div class="fin-flight-times">${escapeHtml(times || (snapshot.inflight ? 'Enroute time unavailable' : 'Times unavailable'))}</div>
  `;
}

function formatFinAltitude(altitude){
  if (!Number.isFinite(altitude)) return '—';
  return `${Math.round(altitude).toLocaleString()} ft`;
}

function formatFinSpeed(speed){
  if (!Number.isFinite(speed)) return '—';
  return `${Math.round(speed)} kts`;
}

function formatFinVerticalSpeed(rate){
  if (!Number.isFinite(rate)) return '—';
  const rounded = Math.round(rate);
  if (rounded === 0) return '0 fpm';
  const symbol = rounded > 0 ? '↑' : '↓';
  return `${symbol} ${Math.abs(rounded).toLocaleString()} fpm`;
}

function formatFinHeading(heading){
  if (!Number.isFinite(heading)) return '—';
  return `${Math.round(heading)}°`;
}

function getCachedAirportTimeZone(code){
  const lookup = airportTimezoneCache || AIRPORT_TZ_FALLBACK;
  const key = String(code || '').toUpperCase();
  return lookup[key] || (key.length === 3 ? lookup[`C${key}`] : null) || null;
}

async function ensureAirportTimezonesLoaded(){
  try {
    await loadAirportTimezones();
  } catch (err){
    console.warn('Time zone preload failed', err);
  }
}

function finArrivalCode(flight){
  if (!flight || typeof flight !== 'object') return '';
  return flight.arrival?.icao || flight.arrival?.iata || flight.arrival?.code || '';
}

function pickFinEtaFromPosition(position){
  const eta = Number(position?.eta);
  if (!Number.isFinite(eta)) return null;
  const nowSec = Date.now() / 1000;
  return eta > (nowSec - 300) ? eta : null;
}

function formatFinLandingMinutes(position){
  const eta = pickFinEtaFromPosition(position);
  if (!Number.isFinite(eta)) return '—';
  const remainingMs = (eta * 1000) - Date.now();
  if (!Number.isFinite(remainingMs)) return '—';
  const totalMinutes = Math.max(0, Math.round(remainingMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${minutes.toString().padStart(2, '0')}`;
}

function formatFinLandingLocalTime(position, flight){
  const eta = pickFinEtaFromPosition(position);
  if (!Number.isFinite(eta)) return '';
  const landingDate = new Date(eta * 1000);
  if (!Number.isFinite(landingDate.getTime())) return '';
  const arrivalCode = finArrivalCode(flight);
  const timeZone = getCachedAirportTimeZone(arrivalCode);
  const options = { hour: '2-digit', minute: '2-digit', hour12: false };
  if (timeZone) options.timeZone = timeZone;
  const timeStr = new Intl.DateTimeFormat(undefined, options).format(landingDate);
  if (!timeStr) return '';
  const label = formatAirportCode(flight?.arrival, finAirportCodeMode);
  const suffix = label && label !== '—' ? `${label} local` : 'arrival local';
  return `${timeStr} ${suffix}`;
}

function normalizeLongitude(lon){
  let value = lon;
  while (value <= -180) value += 360;
  while (value > 180) value -= 360;
  return value;
}

function pickCenterLongitude(lons){
  if (!lons.length) return 0;
  const radVals = lons.map((lon) => normalizeLongitude(lon) * (Math.PI / 180));
  const avgSin = radVals.reduce((sum, v) => sum + Math.sin(v), 0) / radVals.length;
  const avgCos = radVals.reduce((sum, v) => sum + Math.cos(v), 0) / radVals.length;
  return Math.atan2(avgSin, avgCos) * (180 / Math.PI);
}

function projectPoint(lat, lon, centerLon, width, height){
  const clampedLat = Math.max(-85, Math.min(85, lat));
  const lonDelta = normalizeLongitude(lon - centerLon);
  const x = ((lonDelta + 180) / 360) * width;
  const y = ((90 - clampedLat) / 180) * height;
  return { x, y };
}

function buildGreatCirclePath(from, to, centerLon, width, height){
  const toRad = (deg) => deg * (Math.PI / 180);
  const toDeg = (rad) => rad * (180 / Math.PI);
  const lat1 = toRad(from.lat);
  const lon1 = toRad(from.lon);
  const lat2 = toRad(to.lat);
  const lon2 = toRad(to.lon);
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
  ));
  if (!Number.isFinite(d) || d === 0) return '';
  const steps = 96;
  const commands = [];
  for (let i = 0; i <= steps; i += 1){
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    const lat = toDeg(Math.atan2(z, Math.sqrt(x ** 2 + y ** 2)));
    const lon = toDeg(Math.atan2(y, x));
    const { x: px, y: py } = projectPoint(lat, lon, centerLon, width, height);
    commands.push(`${i === 0 ? 'M' : 'L'}${px.toFixed(2)},${py.toFixed(2)}`);
  }
  return commands.join(' ');
}

const BASIC_BASEMAP_SHAPES = [
  {
    id: 'north-america',
    coords: [
      { lat: 72, lon: -168 },
      { lat: 15, lon: -168 },
      { lat: 8, lon: -140 },
      { lat: 8, lon: -110 },
      { lat: 18, lon: -96 },
      { lat: 25, lon: -82 },
      { lat: 32, lon: -78 },
      { lat: 45, lon: -64 },
      { lat: 60, lon: -60 },
      { lat: 72, lon: -82 }
    ]
  },
  {
    id: 'south-america',
    coords: [
      { lat: 12, lon: -82 },
      { lat: -8, lon: -84 },
      { lat: -30, lon: -74 },
      { lat: -56, lon: -70 },
      { lat: -56, lon: -36 },
      { lat: -10, lon: -34 },
      { lat: 12, lon: -54 }
    ]
  },
  {
    id: 'europe-asia-africa',
    coords: [
      { lat: 70, lon: -20 },
      { lat: 72, lon: 30 },
      { lat: 68, lon: 70 },
      { lat: 50, lon: 140 },
      { lat: 35, lon: 140 },
      { lat: 12, lon: 105 },
      { lat: 12, lon: 50 },
      { lat: -35, lon: 50 },
      { lat: -35, lon: -20 },
      { lat: 10, lon: -20 }
    ]
  },
  {
    id: 'australia',
    coords: [
      { lat: -10, lon: 110 },
      { lat: -10, lon: 155 },
      { lat: -45, lon: 155 },
      { lat: -45, lon: 110 }
    ]
  },
  {
    id: 'greenland',
    coords: [
      { lat: 83, lon: -73 },
      { lat: 83, lon: -17 },
      { lat: 70, lon: -17 },
      { lat: 60, lon: -45 },
      { lat: 70, lon: -58 }
    ]
  }
];

function buildPolygonPath(coords, centerLon, width, height){
  const projected = (coords || [])
    .map((pt) => (pt ? projectPoint(pt.lat, pt.lon, centerLon, width, height) : null))
    .filter((pt) => pt && Number.isFinite(pt.x) && Number.isFinite(pt.y));
  if (!projected.length) return '';
  const path = projected.map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ');
  return `${path} Z`;
}

function buildFinStaticMapUrl(position, flight){
  const hasPosition = position && Number.isFinite(position.lat) && Number.isFinite(position.lon);
  const dep = flight?.departure;
  const arr = flight?.arrival;
  const hasDep = dep && Number.isFinite(dep.lat) && Number.isFinite(dep.lon);
  const hasArr = arr && Number.isFinite(arr.lat) && Number.isFinite(arr.lon);
  if (!hasPosition) return '';
  const width = 640;
  const height = 360;
  const centerLon = pickCenterLongitude(
    [position.lon, dep?.lon, arr?.lon].filter((lon) => Number.isFinite(lon))
  );
  const depPt = hasDep ? projectPoint(dep.lat, dep.lon, centerLon, width, height) : null;
  const arrPt = hasArr ? projectPoint(arr.lat, arr.lon, centerLon, width, height) : null;
  const posPt = projectPoint(position.lat, position.lon, centerLon, width, height);
  const path = hasDep && hasArr ? buildGreatCirclePath(dep, arr, centerLon, width, height) : '';
  const heading = Number.isFinite(position.heading) ? position.heading : 0;
  const headingRad = (heading - 90) * (Math.PI / 180);
  const planeSize = 11;
  const nose = {
    x: posPt.x + Math.cos(headingRad) * planeSize,
    y: posPt.y + Math.sin(headingRad) * planeSize
  };
  const tail = {
    x: posPt.x - Math.cos(headingRad) * planeSize * 0.6,
    y: posPt.y - Math.sin(headingRad) * planeSize * 0.6
  };
  const left = {
    x: tail.x + Math.cos(headingRad + (Math.PI / 2)) * planeSize * 0.55,
    y: tail.y + Math.sin(headingRad + (Math.PI / 2)) * planeSize * 0.55
  };
  const right = {
    x: tail.x + Math.cos(headingRad - (Math.PI / 2)) * planeSize * 0.55,
    y: tail.y + Math.sin(headingRad - (Math.PI / 2)) * planeSize * 0.55
  };
  const planePath = `M${nose.x.toFixed(2)},${nose.y.toFixed(2)} L${left.x.toFixed(2)},${left.y.toFixed(2)} L${tail.x.toFixed(2)},${tail.y.toFixed(2)} L${right.x.toFixed(2)},${right.y.toFixed(2)} Z`;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Live route map">
      <defs>
        <linearGradient id="fin-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0f172a" />
          <stop offset="100%" stop-color="#0b121c" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#fin-sky)" />
      <g fill="#0f1b2d" stroke="#1f2937" stroke-width="1" opacity="0.6">
        ${BASIC_BASEMAP_SHAPES.map((shape) => {
          const d = buildPolygonPath(shape.coords, centerLon, width, height);
          return d ? `<path d="${d}" />` : '';
        }).join('')}
      </g>
      <g stroke="#1f2937" stroke-width="1" opacity="0.35">
        ${[-60, -30, 0, 30, 60].map((lat) => {
          const y = projectPoint(lat, centerLon, centerLon, width, height).y;
          return `<line x1="0" y1="${y.toFixed(1)}" x2="${width}" y2="${y.toFixed(1)}" />`;
        }).join('')}
        ${[-120, -60, 0, 60, 120].map((lon) => {
          const x = projectPoint(0, centerLon + lon, centerLon, width, height).x;
          return `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${height}" />`;
        }).join('')}
      </g>
      ${path ? `<path d="${path}" fill="none" stroke="#60a5fa" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />` : ''}
      <g fill="#38bdf8" stroke="#0f172a" stroke-width="2">
        ${depPt ? `<circle cx="${depPt.x.toFixed(2)}" cy="${depPt.y.toFixed(2)}" r="6" />` : ''}
        ${arrPt ? `<circle cx="${arrPt.x.toFixed(2)}" cy="${arrPt.y.toFixed(2)}" r="6" />` : ''}
      </g>
      <g fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="${planePath}" fill="#38bdf8" />
      </g>
      ${(depPt || arrPt) ? `
        <g font-family="system-ui, -apple-system, sans-serif" font-size="13" fill="#e2e8f0" stroke="#0f172a" stroke-width="3" paint-order="stroke">
          ${depPt ? `<text x="${depPt.x.toFixed(2)}" y="${(depPt.y - 10).toFixed(2)}" text-anchor="middle">${escapeHtml(formatAirportCode(dep))}</text>` : ''}
          ${arrPt ? `<text x="${arrPt.x.toFixed(2)}" y="${(arrPt.y - 10).toFixed(2)}" text-anchor="middle">${escapeHtml(formatAirportCode(arr))}</text>` : ''}
        </g>
      ` : ''}
    </svg>
  `.trim();
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function renderFinLiveDetails(container, mapContainer, snapshot, positions){
  if (!container){
    return;
  }
  const hideMap = () => {
    if (mapContainer){
      mapContainer.classList.add('hidden');
      mapContainer.innerHTML = '';
    }
  };
  const inflight = snapshot?.inflight;
  container.classList.toggle('hidden', !inflight);
  if (!inflight){
    container.innerHTML = '';
    hideMap();
    return;
  }
  hideMap();
  const latest = Array.isArray(positions) ? positions.find((p) => p) : null;
  if (!latest){
    container.innerHTML = '<div class="muted-note">Fetching live position…</div>';
    return;
  }
  const landingLocal = formatFinLandingLocalTime(latest, snapshot?.currentFlight);
  const cards = [
    { label: 'Altitude', value: formatFinAltitude(latest.altitude) },
    { label: 'Vertical speed', value: formatFinVerticalSpeed(latest.verticalRate) },
    { label: 'Groundspeed', value: formatFinSpeed(latest.speed) },
    { label: 'Heading', value: formatFinHeading(latest.heading) },
    { label: 'Landing in', value: formatFinLandingMinutes(latest), sub: landingLocal },
    { label: 'Updated', value: latest.timestamp ? formatLocalDateTime(latest.timestamp) : '—', action: 'refresh' }
  ];
  container.innerHTML = `
    ${latest.callsign ? `<div class="muted-note">Callsign ${escapeHtml(latest.callsign)}</div>` : ''}
    <div class="fin-live-grid">
      ${cards.map((card) => `
        <div class="fin-live-card${card.action === 'refresh' ? ' is-actionable' : ''}" ${card.action === 'refresh' ? 'data-fin-live-refresh role="button" tabindex="0" aria-label="Refresh live flight data"' : ''}>
          <div class="metric-label">${escapeHtml(card.label)}</div>
          <div class="metric-value">
            ${escapeHtml(card.value)}
            ${card.sub ? `<div class="fin-live-sub">${escapeHtml(card.sub)}</div>` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  `;
  const refreshCard = container.querySelector('[data-fin-live-refresh]');
  if (refreshCard){
    const triggerRefresh = () => {
      const reg = finHiddenContext.registration;
      if (!reg) return;
      const statusNote = document.getElementById('fin-flight-status');
      if (statusNote) statusNote.textContent = 'Refreshing live data…';
      const flights = FIN_FLIGHT_CACHE.get(reg)?.flights || [];
      const snapshot = buildFinLocationSnapshot(flights);
      loadFinLivePositions(reg, snapshot);
    };
    addTapListener(refreshCard, triggerRefresh);
    refreshCard.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' '){
        event.preventDefault();
        triggerRefresh();
      }
    });
  }
}

async function loadFinLivePositions(registration, snapshot){
  const normalizedReg = normalizeRegistration(registration);
  const liveEl = document.getElementById('fin-flight-live');
  const mapEl = document.getElementById('fin-flight-map');
  await ensureAirportTimezonesLoaded();
  if (liveEl) liveEl.innerHTML = '<div class="muted-note">Fetching live position…</div>';
  if (!snapshot?.inflight){
    renderFinLiveDetails(liveEl, mapEl, snapshot, []);
    return;
  }
  try {
    const { positions } = await fetchFr24LivePositions(normalizedReg);
    renderFinLiveDetails(liveEl, mapEl, snapshot, positions);
    const locationCards = document.querySelectorAll('[data-fin-location]');
    locationCards.forEach((card) => {
      if (card.dataset.finRegistration === normalizedReg){
        const flights = FIN_FLIGHT_CACHE.get(normalizedReg)?.flights || [];
        const snap = buildFinLocationSnapshot(flights);
        renderFinLocationPreview(card, snap, normalizedReg);
      }
    });
  } catch (err){
    const cachedPositions = FIN_LIVE_POSITION_CACHE.get(normalizedReg)?.positions || [];
    if (cachedPositions.length){
      renderFinLiveDetails(liveEl, mapEl, snapshot, cachedPositions);
    }
    if (liveEl){
      const friendly = err?.message && err.message !== 'Failed to fetch'
        ? err.message
        : (cachedPositions.length
          ? 'Live position refresh unavailable right now; showing last known data.'
          : 'Live position unavailable right now.');
      liveEl.innerHTML = `<div class="muted-note">${escapeHtml(friendly)}</div>`;
    }
    if (mapEl) mapEl.classList.toggle('hidden', !cachedPositions.length);
  }
}

function updateFinFlightPage(registration){
  if (finHiddenContext.page !== 'flight') return;
  const normalizedReg = normalizeRegistration(registration);
  if (!normalizedReg || finHiddenContext.registration !== normalizedReg) return;
  const cache = FIN_FLIGHT_CACHE.get(normalizedReg);
  const flights = cache?.flights || [];
  const snapshot = buildFinLocationSnapshot(flights);
  const currentEl = document.getElementById('fin-flight-current');
  const recentEl = document.getElementById('fin-flight-recent');
  const statusEl = document.getElementById('fin-flight-status');
  const liveEl = document.getElementById('fin-flight-live');
  const mapEl = document.getElementById('fin-flight-map');
  renderFinCurrentFlight(currentEl, snapshot);
  renderFinFlightList(recentEl, snapshot.flights, { hideActive: snapshot.inflight });
  const liveCache = FIN_LIVE_POSITION_CACHE.get(normalizedReg);
  renderFinLiveDetails(liveEl, mapEl, snapshot, liveCache?.positions || []);
  if (snapshot.inflight && !(liveCache?.positions?.length)){
    loadFinLivePositions(normalizedReg, snapshot);
  }
  if (statusEl){
    const fetchedText = cache?.fetchedAt ? `Updated ${formatLocalDateTime(Math.round(cache.fetchedAt / 1000))}.` : '';
    const tail = flights.length ? fetchedText : 'No live data available.';
    statusEl.textContent = tail;
  }
  refreshFinCodeToggleButtons();
}

function refreshFinCodeToggleButtons(){
  const toggle = document.getElementById('fin-code-switch');
  const isIata = finAirportCodeMode === 'iata';
  if (toggle){
    toggle.classList.toggle('is-iata', isIata);
    toggle.setAttribute('aria-pressed', String(isIata));
    toggle.setAttribute('aria-label', isIata ? 'Airport codes shown as IATA' : 'Airport codes shown as ICAO');
  }
  document.querySelectorAll('[data-fin-code-label]').forEach((label) => {
    label.classList.toggle('active', label.dataset.finCodeLabel === finAirportCodeMode);
  });
}

function setFinAirportCodeMode(mode){
  finAirportCodeMode = mode === 'iata' ? 'iata' : 'icao';
  refreshFinCodeToggleButtons();
  document.querySelectorAll('[data-fin-location]').forEach((card) => {
    const reg = card.dataset.finRegistration || '';
    const flights = reg ? FIN_FLIGHT_CACHE.get(reg)?.flights || [] : [];
    const snapshot = buildFinLocationSnapshot(flights);
    renderFinLocationPreview(card, snapshot, reg);
  });
  if (finHiddenContext.page === 'flight'){
    updateFinFlightPage(finHiddenContext.registration);
  }
}

function setFlightLookupCarrier(mode){
  const normalized = ['ACA', 'ROU', 'OTHER'].includes(String(mode)) ? mode : 'OTHER';
  flightLookupCarrier = normalized;
  document.querySelectorAll('[data-flight-carrier]').forEach((btn) => {
    const active = btn.dataset.flightCarrier === flightLookupCarrier;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function buildFlightLookupCallsign(number){
  const raw = normalizeCallsign(number).replace(/\s+/g, '');
  if (!raw) return '';
  if (flightLookupCarrier === 'ACA'){
    if (/^ACA/i.test(raw)) return raw;
    if (/^AC/i.test(raw)) return `ACA${raw.slice(2)}`;
    if (/^\d+/.test(raw)) return `ACA${raw}`;
    return raw;
  }
  if (flightLookupCarrier === 'ROU'){
    if (/^ROU/i.test(raw)) return raw;
    if (/^RV/i.test(raw)) return `ROU${raw.slice(2)}`;
    if (/^\d+/.test(raw)) return `ROU${raw}`;
    return raw;
  }
  return raw;
}

function clearFlightLookupResults(){
  const outEl = document.getElementById('fin-flightnumber-results');
  const statusEl = document.getElementById('fin-flightnumber-status');
  if (outEl) outEl.innerHTML = '';
  if (statusEl) statusEl.textContent = '';
}

function handleFlightRegistrationOpen(fin, registration){
  const modernFinInput = document.getElementById('modern-fin-input');
  if (modernFinInput){
    modernFinInput.value = String(fin);
    setModernPrimaryTab('modern-fin');
    setModernFinTab('modern-fin-qrh');
    renderFinResult(document.getElementById('modern-fin-out'), String(fin));
    closeFinHiddenPage();
    finHiddenContext.registration = normalizeRegistration(registration);
  }
}

function renderFlightLookupResult({ callsign, snapshot, positions, registration }){
  const outEl = document.getElementById('fin-flightnumber-results');
  const statusEl = document.getElementById('fin-flightnumber-status');
  if (!outEl) return;
  const latest = Array.isArray(positions) ? positions.find((p) => p) : null;
  const current = snapshot?.currentFlight || null;
  const hasData = latest || current;
  if (!hasData){
    outEl.innerHTML = '';
    if (statusEl) statusEl.textContent = `No live data found for ${callsign || 'that flight'}.`;
    return;
  }
  const registrationValue = normalizeRegistration(
    registration
    || latest?.registration
    || current?.registration
  );
  const finMatch = findFinByRegistration(registrationValue);
  const landingLocal = latest ? formatFinLandingLocalTime(latest, current) : '';
  const landingIn = latest ? formatFinLandingMinutes(latest) : '—';
  const cards = [
    { label: 'Callsign', value: callsign || latest?.callsign || '—' },
    {
      label: 'Registration',
      value: registrationValue || '—',
      actionable: Boolean(finMatch),
      fin: finMatch?.fin,
      registration: registrationValue
    },
    { label: 'Altitude', value: latest ? formatFinAltitude(latest.altitude) : '—' },
    { label: 'Groundspeed', value: latest ? formatFinSpeed(latest.speed) : '—' },
    { label: 'Vertical speed', value: latest ? formatFinVerticalSpeed(latest.verticalRate) : '—' },
    { label: 'Heading', value: latest ? formatFinHeading(latest.heading) : '—' },
    { label: 'Landing in', value: landingIn, sub: landingLocal }
  ];
  if (latest){
    cards.push({
      label: 'Updated',
      value: latest.timestamp ? formatLocalDateTime(latest.timestamp) : '—',
      action: 'refresh'
    });
  }
  const meta = [
    current ? describeFr24Status(current.status) : null,
    current ? formatFinRoute(current) : null
  ].filter(Boolean).join(' • ');
  outEl.innerHTML = `
    <div class="fin-flight-meta">${escapeHtml(meta || 'Flight details')}</div>
    <div class="fin-live-grid">
      ${cards.map((card) => {
        const actionAttrs = card.action === 'refresh' ? 'data-flight-refresh role="button" tabindex="0" aria-label="Refresh live flight data"' : '';
        const finAttrs = card.actionable ? `data-flight-open-fin="${card.fin}" data-flight-registration="${escapeHtml(card.registration || '')}" role="button" tabindex="0" aria-label="Open fin ${card.fin}"` : '';
        const roleAttrs = card.actionable ? finAttrs : actionAttrs;
        const actionableClass = (card.action === 'refresh' || card.actionable) ? ' is-actionable' : '';
        const sub = card.sub ? `<div class="fin-live-sub">${escapeHtml(card.sub)}</div>` : '';
        return `
          <div class="fin-live-card${actionableClass}" ${roleAttrs}>
            <div class="metric-label">${escapeHtml(card.label)}</div>
            <div class="metric-value">
              ${escapeHtml(card.value || '—')}
              ${sub}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
  if (statusEl){
    statusEl.textContent = 'Live flight lookup complete.';
  }
  outEl.querySelectorAll('[data-flight-open-fin]').forEach((card) => {
    addTapListener(card, () => {
      const fin = Number(card.dataset.flightOpenFin);
      const reg = card.dataset.flightRegistration;
      if (Number.isFinite(fin)) handleFlightRegistrationOpen(fin, reg);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' '){
        event.preventDefault();
        const fin = Number(card.dataset.flightOpenFin);
        const reg = card.dataset.flightRegistration;
        if (Number.isFinite(fin)) handleFlightRegistrationOpen(fin, reg);
      }
    });
  });
  const refreshCard = outEl.querySelector('[data-flight-refresh]');
  if (refreshCard){
    const triggerRefresh = () => {
      const input = document.getElementById('fin-flightnumber-input');
      const callsignInput = buildFlightLookupCallsign(input?.value || '');
    if (callsignInput){
      loadFlightLookup(callsignInput, { preferRegistration: registrationValue });
    }
  };
    addTapListener(refreshCard, triggerRefresh);
    refreshCard.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' '){
        event.preventDefault();
        triggerRefresh();
      }
    });
  }
}

async function loadFlightLookup(callsign, { preferRegistration } = {}){
  const statusEl = document.getElementById('fin-flightnumber-status');
  const outEl = document.getElementById('fin-flightnumber-results');
  if (statusEl) statusEl.textContent = 'Fetching flight…';
  if (outEl) outEl.innerHTML = '';
  try {
    let registration = normalizeRegistration(preferRegistration || '');
    let positions = [];
    let flights = [];
    try {
      const live = await fetchFr24LivePositionsByFlight(callsign);
      positions = Array.isArray(live.positions) ? live.positions : [];
      flights = Array.isArray(live.flights) ? live.flights : [];
      if (!registration){
        registration = normalizeRegistration(live.positions?.[0]?.registration || live.flights?.[0]?.registration);
      }
    } catch (liveErr){
      console.warn('Flight callsign live lookup failed', liveErr);
    }
    try {
      const summary = await fetchFr24FlightSummary({ flight: callsign });
      if (Array.isArray(summary.flights) && summary.flights.length){
        flights = summary.flights;
      }
      if (!registration){
        registration = normalizeRegistration(summary.flights?.[0]?.registration);
      }
    } catch (summaryErr){
      console.warn('Flight summary lookup failed; relying on live data', summaryErr);
    }
    const snapshot = buildFinLocationSnapshot(flights);
    if (!positions.length && registration){
      try {
        const regLive = await fetchFr24LivePositions(registration);
        positions = Array.isArray(regLive.positions) ? regLive.positions : [];
      } catch (regErr){
        console.warn('Registration live lookup fallback failed', regErr);
      }
    }
    renderFlightLookupResult({ callsign, snapshot, positions, registration });
  } catch (err){
    if (statusEl){
      statusEl.textContent = err?.message || 'Live flight data unavailable right now.';
    }
  }
}

async function fetchFr24FlightSummary(input){
  const opts = typeof input === 'string' ? { registration: input } : (input || {});
  const normalizedReg = normalizeRegistration(opts.registration || opts.registrations || opts.reg);
  const normalizedFlight = normalizeCallsign(opts.flight || opts.flightNumber || opts.callsign);
  if (!normalizedReg && !normalizedFlight) throw new Error('Enter a registration or flight to fetch flight summaries.');
  const config = getFr24ApiConfig();
  const headers = buildFr24Headers();
  const hasAuthHeader = Object.keys(headers || {}).some((key) => {
    const lower = key.toLowerCase();
    return lower === 'authorization' || lower === 'x-api-key';
  });
  const requiresAuth = (config.baseUrl || '').toLowerCase().includes('flightradar24');
  if (requiresAuth && !hasAuthHeader){
    throw new Error('FlightRadar24 API token not configured. Add it in the FlightRadar24 API settings.');
  }
  const now = new Date();
  const from = new Date(now.getTime() - (FR24_SUMMARY_LOOKBACK_HOURS * 60 * 60 * 1000));
  const params = {
    flight_datetime_from: formatFr24DateTimeUtc(from),
    flight_datetime_to: formatFr24DateTimeUtc(now),
    limit: 200
  };
  if (normalizedReg) params.registrations = normalizedReg;
  if (normalizedFlight) params.flight = normalizedFlight;
  let flights = [];
  let summaryError = null;
  try {
    const url = buildFr24Url('flight-summary/full', params);
    const resp = await fetchWithCorsFallback(url, { headers, cache: 'no-store' });
    if (!resp.ok) throw new Error(`FlightRadar24 error ${resp.status}`);
    const json = await resp.json();
    const rows = extractFr24DataRows(json);
    flights = rows.map(mapFr24FullSummaryFlight).filter(Boolean);
  } catch (err){
    summaryError = err;
  }
  if (!flights.length){
    try {
      const liveParams = normalizedFlight
        ? { callsigns: normalizedFlight }
        : { registrations: normalizedReg };
      const live = await fetchFr24LivePositionsFull(liveParams);
      flights = Array.isArray(live.flights) ? live.flights : [];
    } catch (liveErr){
      if (summaryError){
        const combined = new Error(summaryError?.message || 'Live data unavailable.');
        combined.cause = liveErr;
        throw combined;
      }
      throw liveErr;
    }
  }
  if (!flights.length && summaryError){
    throw summaryError;
  }
  return { flights, registration: normalizedReg, flight: normalizedFlight };
}

function mapFr24LivePosition(entry){
  const pickNumber = (...values) => {
    for (const value of values){
      if (value === null || value === undefined) continue;
      const num = Number(value);
      if (Number.isFinite(num)) return num;
    }
    return null;
  };
  const parseLiveTime = (value) => {
    const parsed = parseFr24Date(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  if (!entry || typeof entry !== 'object') return null;
  const lat = pickNumber(
    entry.lat,
    entry.latitude,
    entry.lat_deg,
    entry.position?.lat,
    entry.position?.latitude
  );
  const lon = pickNumber(
    entry.lon,
    entry.lng,
    entry.longitude,
    entry.long_deg,
    entry.position?.lon,
    entry.position?.longitude
  );
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const altitude = pickNumber(
    entry.alt,
    entry.altitude,
    entry.altitude_baro,
    entry.alt_baro,
    entry.baro_altitude
  );
  const speed = pickNumber(
    entry.gspeed,
    entry.gs,
    entry.groundspeed,
    entry.ground_speed,
    entry.speed,
    entry.velocity,
    entry.spd,
    entry.horizontal_speed
  );
  const heading = pickNumber(
    entry.track,
    entry.heading,
    entry.direction,
    entry.bearing,
    entry.dir,
    entry.course
  );
  const verticalRate = pickNumber(
    entry.vspeed,
    entry.vertical_speed,
    entry.verticalRate,
    entry.vert_rate,
    entry.rate_vertical,
    entry.rate
  );
  const timestamp = parseLiveTime(
    entry.timestamp
    ?? entry.time
    ?? entry.last_position
    ?? entry.last_update
    ?? entry.updated
    ?? entry.update_time
  );
  const eta = parseLiveTime(
    entry.eta
    ?? entry.estimated_arrival
    ?? entry.estimated_arrival_utc
    ?? entry.estimated_arrival_time
    ?? entry.eta_timestamp
    ?? entry.eta_utc
    ?? entry.est_arrival
    ?? entry.arrival_time
    ?? entry.arrival?.eta
    ?? entry.arrival?.estimated
    ?? entry.dest?.eta
  );
  const callsign = typeof entry.callsign === 'string'
    ? entry.callsign
    : (typeof entry.call_sign === 'string'
    ? entry.call_sign
    : (typeof entry.flight === 'string' ? entry.flight : ''));
  const registration = normalizeRegistration(
    entry.reg
    ?? entry.registration
    ?? entry.aircraft_registration
    ?? entry.aircraft?.registration
    ?? entry.identification?.registration
  );
  const icao24 = normalizeRegistration(entry.hex || entry.icao24 || entry.mode_s || entry.icao);
  return {
    lat,
    lon,
    altitude: Number.isFinite(altitude) ? altitude : null,
    speed: Number.isFinite(speed) ? speed : null,
    heading: Number.isFinite(heading) ? heading : null,
    verticalRate: Number.isFinite(verticalRate) ? verticalRate : null,
    timestamp,
    eta,
    callsign,
    registration,
    icao24
  };
}

function mapFr24PublicLivePosition(entry, callsign){
  if (!entry || typeof entry !== 'object') return null;
  const meters = entry.altitude?.meters;
  const altitude = Number.isFinite(entry.altitude?.feet)
    ? entry.altitude.feet
    : (Number.isFinite(meters) ? meters * 3.28084 : entry.alt);
  const kmh = entry.speed?.horizontal?.kmh;
  const speed = Number.isFinite(entry.speed?.horizontal?.kts)
    ? entry.speed.horizontal.kts
    : (Number.isFinite(kmh) ? kmh * 0.539957 : (entry.spd ?? entry.speed));
  const shaped = {
    lat: entry.lat ?? entry.latitude ?? entry.position?.latitude,
    lon: entry.lon ?? entry.lng ?? entry.longitude ?? entry.position?.longitude,
    altitude,
    speed,
    heading: entry.hd ?? entry.heading ?? entry.direction ?? entry.dir,
    verticalRate: entry.roc ?? entry.vs ?? entry.vertical_rate ?? entry.verticalRate ?? entry.rate,
    timestamp: entry.ts ?? entry.timestamp ?? entry.updated ?? entry.time,
    eta: entry.eta ?? entry.est_arrival ?? entry.arrival?.estimated?.utc
  };
  const mapped = mapFr24LivePosition(shaped);
  if (!mapped) return null;
  if (callsign && !mapped.callsign){
    mapped.callsign = callsign;
  }
  return mapped;
}

async function fetchFr24PublicLivePositions(registration){
  const normalizedReg = normalizeRegistration(registration);
  if (!normalizedReg) throw new Error('Enter a registration to fetch live positions.');
  const searchReg = normalizedReg.replace(/[^A-Z0-9]/gi, '');
  const url = `${FLIGHTRADAR24_PUBLIC_BASE}/common/v1/flight/list.json?query=${encodeURIComponent(searchReg)}&fetchBy=reg&limit=1`;
  const resp = await fetchWithCorsFallback(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`FlightRadar24 public API error ${resp.status}`);
  const json = await resp.json();
  const flights = json?.result?.response?.data;
  if (!Array.isArray(flights) || !flights.length) return { positions: [], registration: normalizedReg };
  const match = flights.find((flight) => normalizeRegistration(flight?.aircraft?.registration) === normalizedReg) || flights[0];
  const callsign = match?.identification?.callsign || match?.identification?.number?.default || '';
  const trail = Array.isArray(match?.trail) ? [...match.trail].reverse() : [];
  const trailPositions = trail.map((item) => mapFr24PublicLivePosition(item, callsign)).filter(Boolean);
  let livePositions = trailPositions;
  if (!livePositions.length && match?.status?.live?.position){
    const mapped = mapFr24PublicLivePosition(match.status.live, callsign);
    livePositions = mapped ? [mapped] : [];
  }
  return { positions: livePositions, registration: normalizedReg };
}

async function fetchFr24LivePositionsFull(params = {}, { requireAuth = true } = {}){
  const headers = buildFr24Headers();
  const hasAuthHeader = Object.keys(headers || {}).some((key) => {
    const lower = String(key || '').toLowerCase();
    return lower === 'authorization' || lower === 'x-api-key';
  });
  const config = getFr24ApiConfig();
  const needsAuth = requireAuth || isOfficialFr24Base(config.baseUrl);
  if (needsAuth && !hasAuthHeader){
    throw new Error('FlightRadar24 API token not configured. Add it in the FlightRadar24 API settings.');
  }
  const url = buildFr24Url('live/flight-positions/full', params);
  const resp = await fetchWithCorsFallback(url, { headers, cache: 'no-store' });
  if (!resp.ok) throw new Error(`FlightRadar24 error ${resp.status}`);
  const json = await resp.json();
  const rows = extractFr24DataRows(json);
  const mapped = rows.map((entry) => {
    const position = mapFr24LivePosition(entry);
    const summary = mapFr24LiveSummaryFlight(entry);
    return { position, summary };
  }).filter((item) => item.position);
  return {
    positions: mapped.map((item) => item.position),
    flights: mapped.map((item) => item.summary).filter(Boolean),
    raw: rows
  };
}

async function fetchFr24LivePositionsByFlight(flight){
  const normalizedFlight = normalizeCallsign(flight);
  if (!normalizedFlight) throw new Error('Enter a flight number to fetch live positions.');
  const attemptKeys = [
    { callsigns: normalizedFlight },
    { flight: normalizedFlight }
  ];
  const attempts = [];
  for (const key of attemptKeys){
    try {
      const result = await fetchFr24LivePositionsFull(key);
      const positions = Array.isArray(result.positions) ? result.positions : [];
      const flights = Array.isArray(result.flights) ? result.flights : [];
      if (positions.length || flights.length){
        return { positions, flight: normalizedFlight, flights };
      }
    } catch (err){
      attempts.push(`${JSON.stringify(key)}: ${err?.message || err}`);
    }
  }
  try {
    const publicResult = await fetchFr24PublicLivePositionsByFlight(normalizedFlight);
    const positions = Array.isArray(publicResult.positions) ? publicResult.positions : [];
    const flights = Array.isArray(publicResult.flights) ? publicResult.flights : [];
    if (positions.length || flights.length){
      return { positions, flight: normalizedFlight, flights, registration: publicResult.registration };
    }
  } catch (publicErr){
    attempts.push(`public: ${publicErr?.message || publicErr}`);
  }
  const error = new Error(attempts.length ? attempts.join('; ') : 'Live data unavailable.');
  error.attempts = attempts;
  throw error;
}

async function fetchFr24PublicLivePositionsByFlight(flight){
  const normalizedFlight = normalizeCallsign(flight);
  if (!normalizedFlight) throw new Error('Enter a flight number to fetch live positions.');
  const searchFlight = normalizedFlight.replace(/[^A-Z0-9]/gi, '');
  const url = `${FLIGHTRADAR24_PUBLIC_BASE}/common/v1/flight/list.json?query=${encodeURIComponent(searchFlight)}&fetchBy=flight&limit=1`;
  const resp = await fetchWithCorsFallback(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`FlightRadar24 public API error ${resp.status}`);
  const json = await resp.json();
  const flights = json?.result?.response?.data;
  if (!Array.isArray(flights) || !flights.length) return { positions: [], flights: [], registration: '' };
  const findMatch = (entry) => {
    const callsign = normalizeCallsign(
      entry?.identification?.callsign
      || entry?.identification?.number?.default
      || entry?.flight
    );
    return callsign === normalizedFlight;
  };
  const match = flights.find(findMatch) || flights[0];
  const callsign = normalizeCallsign(
    match?.identification?.callsign
    || match?.identification?.number?.default
    || normalizedFlight
  );
  const registration = normalizeRegistration(match?.aircraft?.registration);
  const trail = Array.isArray(match?.trail) ? [...match.trail].reverse() : [];
  const trailPositions = trail.map((item) => mapFr24PublicLivePosition(item, callsign)).filter(Boolean);
  let livePositions = trailPositions;
  if (!livePositions.length && match?.status?.live?.position){
    const mapped = mapFr24PublicLivePosition(match.status.live, callsign);
    livePositions = mapped ? [mapped] : [];
  }
  return { positions: livePositions, flights: [], registration };
}

async function fetchFr24LivePositions(registration){
  const normalizedReg = normalizeRegistration(registration);
  if (!normalizedReg) throw new Error('Enter a registration to fetch live positions.');
  const attempts = [];
  try {
    const official = await fetchFr24LivePositionsFull({ registrations: normalizedReg });
    const officialPositions = Array.isArray(official.positions) ? official.positions : [];
    let positions = officialPositions;
    if (!positions.length){
      console.warn('FlightRadar24 live endpoint returned no positions; trying public fallback.');
      try {
        const fallback = await fetchFr24PublicLivePositions(normalizedReg);
        if (Array.isArray(fallback?.positions) && fallback.positions.length){
          positions = fallback.positions;
        }
      } catch (fallbackErr){
        attempts.push(fallbackErr);
      }
    }
    FIN_LIVE_POSITION_CACHE.set(normalizedReg, { positions, fetchedAt: Date.now() });
    return { positions, registration: normalizedReg, flights: official.flights || [] };
  } catch (officialErr){
    attempts.push(officialErr);
    console.warn('Official FlightRadar24 live positions failed', officialErr);
    try {
      const fallback = await fetchFr24PublicLivePositions(normalizedReg);
      const positions = Array.isArray(fallback?.positions) ? fallback.positions : [];
      FIN_LIVE_POSITION_CACHE.set(normalizedReg, { positions, fetchedAt: Date.now() });
      return { positions, registration: normalizedReg };
    } catch (fallbackErr){
      const error = new Error(officialErr?.message || 'Live data unavailable.');
      error.cause = fallbackErr;
      error.attempts = attempts;
      throw error;
    }
  }
}

function getLatestLivePosition(registration){
  const cache = FIN_LIVE_POSITION_CACHE.get(normalizeRegistration(registration));
  const positions = cache?.positions;
  if (!Array.isArray(positions) || !positions.length) return null;
  return positions.find((p) => p) || null;
}

function renderFinLocationPreview(summaryEl, snapshot, registration){
  const statusEl = summaryEl.querySelector('[data-fin-location-status]');
  const displayEl = summaryEl.querySelector('[data-fin-location-display]');
  summaryEl.dataset.finRegistration = registration || '';
  if (!statusEl || !displayEl) return;
  if (!snapshot.flights.length){
    displayEl.textContent = '—';
    statusEl.textContent = `No recent flights found for ${registration || 'this fin'}.`;
    return;
  }
  if (snapshot.inflight){
    displayEl.textContent = 'In Flight';
    const route = formatFinRoute(snapshot.currentFlight);
    const meta = snapshot.currentFlight?.flightNumber ? ` • ${snapshot.currentFlight.flightNumber}` : '';
    const livePosition = getLatestLivePosition(registration);
    const landing = formatFinLandingMinutes(livePosition);
    const landingText = landing !== '—' ? ` • Landing in ${landing}` : '';
    statusEl.textContent = `${route}${meta}${landingText}`;
    return;
  }
  const code = formatAirportCode(snapshot.airport, finAirportCodeMode);
  displayEl.textContent = code || 'Unknown location';
  const label = snapshot.currentFlight?.status === 'planned' ? 'Planned' : 'Last arrival';
  statusEl.textContent = `${label}: ${formatFinRoute(snapshot.currentFlight)}`;
}

async function hydrateFinLocation(outEl, fin, reg){
  const summaryEl = outEl.querySelector('[data-fin-location]');
  const statusEl = outEl.querySelector('[data-fin-location-status]');
  const displayEl = outEl.querySelector('[data-fin-location-display]');
  if (!summaryEl || !statusEl || !displayEl) return;
  const normalizedReg = normalizeRegistration(reg);
  const requestId = `${fin}-${Date.now()}`;
  summaryEl.dataset.finLocationRequest = requestId;
  summaryEl.dataset.finRegistration = normalizedReg || '';
  summaryEl.dataset.finFin = fin;
  const cachedFlights = normalizedReg ? FIN_FLIGHT_CACHE.get(normalizedReg)?.flights || [] : [];
  if (cachedFlights.length){
    const cachedSnapshot = buildFinLocationSnapshot(cachedFlights);
    renderFinLocationPreview(summaryEl, cachedSnapshot, normalizedReg);
  } else {
    displayEl.textContent = normalizedReg ? '—' : 'No registration';
    statusEl.textContent = normalizedReg
      ? 'Fetching FlightRadar24 summary…'
      : 'Add a registration to track this fin.';
  }
  if (!normalizedReg) return;
  try {
    const { flights, registration } = await fetchFr24FlightSummary(normalizedReg);
    if (summaryEl.dataset.finLocationRequest !== requestId) return;
    const sorted = cacheFinFlights(registration, flights);
    const snapshot = buildFinLocationSnapshot(sorted);
    renderFinLocationPreview(summaryEl, snapshot, registration);
    if (snapshot.inflight){
      try {
        await fetchFr24LivePositions(registration);
        const refreshedSnapshot = buildFinLocationSnapshot(sorted);
        renderFinLocationPreview(summaryEl, refreshedSnapshot, registration);
      } catch (liveErr){
        console.warn('Live position unavailable for fin preview', liveErr);
      }
    }
    updateFinFlightPage(registration);
  } catch (err){
    if (summaryEl.dataset.finLocationRequest !== requestId) return;
    const friendly = err?.message && err.message !== 'Failed to fetch'
      ? err.message
      : 'FlightRadar24 summary unavailable right now.';
    displayEl.textContent = '—';
    statusEl.textContent = friendly;
  }
}

function getFinFormData(form){
  const getValue = (field) => form.querySelector(`[data-fin-field="${field}"]`)?.value ?? '';
  const finStart = Number(getValue('finStart'));
  const reg = normalizeRegistration(getValue('reg'));
  return {
    type: getValue('type'),
    finStart,
    finEnd: finStart,
    j: Number(getValue('j')),
    o: Number(getValue('o')),
    y: Number(getValue('y')),
    fdjs: Number(getValue('fdjs')),
    ofcr: Number(getValue('ofcr')),
    ccjs: Number(getValue('ccjs')),
    reg,
    notes: getValue('notes').trim()
  };
}

function validateFinConfig(config){
  if (!String(config.type ?? '').trim()) return 'Enter an aircraft type.';
  if (!Number.isFinite(config.finStart)) return 'Enter a valid fin number.';
  if (config.finStart <= 0) return 'Fin must be at least 1.';
  const numericFields = ['j', 'o', 'y', 'fdjs', 'ofcr', 'ccjs'];
  for (const field of numericFields){
    if (!Number.isFinite(config[field])) return 'Enter numeric values for all fields.';
  }
  const reg = normalizeRegistration(config.reg);
  if (reg && !/^[A-Z0-9-]+$/.test(reg)){
    return 'Registration can use letters, numbers, or dashes.';
  }
  if (reg.length > 12){
    return 'Registration must be 12 characters or fewer.';
  }
  const notes = String(config.notes ?? '');
  if (notes.length > 2000) return 'Notes must be 2000 characters or fewer.';
  return null;
}

function upsertCustomFinConfig(config, targetFin){
  const normalized = normalizeFinConfig(config);
  if (!normalized) return null;
  const fin = Number(targetFin);
  const next = customFinConfigs.filter(row => !Number.isFinite(fin) || !(fin >= row.finStart && fin <= row.finEnd));
  next.push(normalized);
  saveCustomFinConfigs(next);
  return normalized;
}

function removeCustomFinConfig(fin){
  if (!Number.isFinite(fin)) return false;
  const next = customFinConfigs.filter(row => !(fin >= row.finStart && fin <= row.finEnd));
  if (next.length === customFinConfigs.length) return false;
  saveCustomFinConfigs(next);
  return true;
}

function deleteFinFromConfigs(fin){
  if (!Number.isFinite(fin)) return false;
  const custom = findCustomFinConfig(fin);
  if (custom){
    return removeCustomFinConfig(fin);
  }
  const base = FIN_CONFIGS.find(row => fin >= row.finStart && fin <= row.finEnd);
  if (!base) return false;
  const next = customFinConfigs.filter(row => !(fin >= row.finStart && fin <= row.finEnd));
  next.push({ finStart: fin, finEnd: fin, deleted: true, type: base.type });
  saveCustomFinConfigs(next);
  return true;
}

const finSyncCapabilityProbe = {
  backgroundSync: false,
  periodicBackgroundSync: false,
  backgroundFetch: false,
  persistentStorage: false,
  errors: []
};

async function investigateBackgroundFinSync(){
  const result = { ...finSyncCapabilityProbe, errors: [] };
  if (!('serviceWorker' in navigator)){
    result.errors.push('Service worker unavailable; background sync unsupported.');
  } else {
    try {
      const reg = await navigator.serviceWorker.ready;
      result.backgroundSync = typeof reg.sync === 'object';
      result.periodicBackgroundSync = typeof reg.periodicSync === 'object';
      result.backgroundFetch = typeof reg.backgroundFetch === 'object';
    } catch (err){
      result.errors.push(`Service worker readiness failed: ${err.message}`);
    }
  }
  if (navigator.storage?.persist){
    try{
      const persisted = await navigator.storage.persisted();
      result.persistentStorage = persisted || await navigator.storage.persist();
    } catch (err){
      result.errors.push(`Storage persistence check failed: ${err.message}`);
    }
  } else {
    result.errors.push('Persistent storage API unavailable.');
  }
  window.__acpayFinSyncCapabilities = result;
  console.info('Fin sync background capability probe', result);
  return result;
}

const finDeleteState = { fin: null, isCustom: false, isBuiltIn: false };

function getFinDeleteOverlay(){
  let overlay = document.getElementById('fin-delete-overlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'fin-delete-overlay';
  overlay.className = 'fin-confirm-overlay hidden';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="fin-confirm-dialog" role="document">
      <h4>Delete fin</h4>
      <p data-fin-delete-message></p>
      <div class="fin-confirm-actions">
        <button type="button" class="btn btn-secondary" data-fin-delete-cancel>Cancel</button>
        <button type="button" class="btn btn-danger" data-fin-delete-confirm>Delete fin</button>
      </div>
    </div>
  `;
  addTapListener(overlay, (event) => {
    if (event.target === overlay){
      closeFinDeleteOverlay();
    }
  });
  addTapListener(overlay.querySelector('[data-fin-delete-cancel]'), closeFinDeleteOverlay);
  addTapListener(overlay.querySelector('[data-fin-delete-confirm]'), () => {
    const fin = finDeleteState.fin;
    deleteFinFromConfigs(fin);
    refreshFinResults();
    closeFinDeleteOverlay();
  });
  document.body.appendChild(overlay);
  return overlay;
}

function openFinDeleteOverlay(fin, { isCustom } = {}){
  const overlay = getFinDeleteOverlay();
  const message = overlay.querySelector('[data-fin-delete-message]');
  const confirm = overlay.querySelector('[data-fin-delete-confirm]');
  const base = FIN_CONFIGS.find(row => fin >= row.finStart && fin <= row.finEnd);
  finDeleteState.fin = fin;
  finDeleteState.isCustom = Boolean(isCustom);
  finDeleteState.isBuiltIn = Boolean(base) && !isCustom;
  if (message){
    if (finDeleteState.isCustom){
      message.textContent = `Are you sure you want to delete fin ${fin}?`;
    } else if (finDeleteState.isBuiltIn){
      message.textContent = `Fin ${fin} is built into the app. Deleting will hide it on this device until you add it back.`;
    } else {
      message.textContent = `Are you sure you want to delete fin ${fin}?`;
    }
  }
  if (confirm){
    confirm.textContent = finDeleteState.isBuiltIn ? 'Hide fin' : 'Delete fin';
  }
  overlay.classList.remove('hidden');
  overlay.querySelector('[data-fin-delete-cancel]')?.focus();
}

function closeFinDeleteOverlay(){
  const overlay = document.getElementById('fin-delete-overlay');
  if (overlay){
    overlay.classList.add('hidden');
  }
  finDeleteState.fin = null;
  finDeleteState.isCustom = false;
  finDeleteState.isBuiltIn = false;
}

function renderFinResult(outEl, finValue){
  if (!outEl) return;
  outEl.dataset.finRegistration = '';
  const previousFin = Number(outEl.dataset.finCurrent ?? NaN);
  const fin = Number(finValue);
  const finChanged = Number.isFinite(fin) && Number.isFinite(previousFin) && previousFin !== fin;
  if (finChanged){
    outEl.dataset.finEditing = 'false';
  }
  const editing = outEl.dataset.finEditing === 'true';
  outEl.dataset.finCurrent = Number.isFinite(fin) ? String(fin) : '';
  if (finValue === '' || finValue === null || finValue === undefined){
    outEl.dataset.finEditing = 'false';
    outEl.innerHTML = '<div class="muted-note">Enter a fin to see configuration details.</div>';
    return;
  }
  if (!Number.isFinite(fin)){
    outEl.dataset.finEditing = 'false';
    outEl.innerHTML = '<div class="wx-error">Enter a valid fin number.</div>';
    return;
  }
  const row = findFinConfig(fin);
  const customConfig = findCustomFinConfig(fin);
  const isDeletedFin = Boolean(customConfig?.deleted);
  const coreRow = FIN_CONFIGS.find(r => fin >= r.finStart && fin <= r.finEnd) || null;
  if (!row){
    outEl.dataset.finEditing = 'false';
    const restoreButton = isDeletedFin ? '<button type="button" class="btn btn-secondary" data-fin-action="restore">Restore fin</button>' : '';
    const message = isDeletedFin
      ? `<div class="wx-error">This fin was deleted from your device.</div>`
      : `<div class="wx-error">No configuration found for that fin.</div>`;
    outEl.innerHTML = `
      ${message}
      <div class="fin-actions">
        ${restoreButton}
        <button type="button" class="btn" data-fin-action="add">Add fin</button>
      </div>
      ${renderFinForm(finFormValuesFromRow(coreRow, fin))}
    `;
    return;
  }
  outEl.dataset.finEditing = editing ? 'true' : 'false';
  const values = finFormValuesFromRow(row, fin);
  const seats = `${row.j}/${row.o}/${row.y}`;
  const cards = [
    renderFinCard({
      label: 'Aircraft type',
      display: escapeHtml(values.type),
      edit: `<input type="text" inputmode="text" data-fin-field="type" value="${escapeHtml(values.type)}">`
    })
  ];
  const showRegCard = editing || Boolean(values.reg);
  if (showRegCard){
    cards.push(renderFinCard({
      label: 'Reg.',
      display: values.reg ? escapeHtml(values.reg) : '—',
      edit: `<input type="text" inputmode="text" autocapitalize="characters" data-fin-field="reg" value="${escapeHtml(values.reg)}" placeholder="e.g., C-FIVS">`
    }));
  }
  cards.push(
    renderFinCard({
      label: 'Fin number',
      display: `${fin}`,
      edit: `<input type="number" min="1" inputmode="numeric" data-fin-field="finStart" value="${values.finStart}">`,
      editOnly: false
    }),
    renderFinCard({
      label: 'FD Jumps',
      display: `${row.fdjs}`,
      edit: `<input type="number" min="0" inputmode="numeric" data-fin-field="fdjs" value="${values.fdjs}">`
    }),
    renderFinCard({
      label: 'Cabin Jumps',
      display: `${row.ccjs}`,
      edit: `<input type="number" min="0" inputmode="numeric" data-fin-field="ccjs" value="${values.ccjs}">`
    }),
    renderFinCard({
      label: 'Seats (J/O/Y)',
      display: seats,
      edit: renderFinSeatInputs(values)
    })
  );
  if (isWidebodyType(row.type) || editing){
    cards.push(renderFinCard({
      label: 'Bunks',
      display: `${row.ofcr}`,
      edit: `<input type="number" min="0" inputmode="numeric" data-fin-field="ofcr" value="${values.ofcr}">`,
      editOnly: !isWidebodyType(row.type)
    }));
  }
  const deleteDisabled = '';
  const notesText = typeof row.notes === 'string' ? row.notes.trim() : '';
  const notesBody = notesText
    ? `<div class="fin-notes-body">${escapeHtml(notesText).replace(/\n/g, '<br>')}</div>`
    : '<div class="fin-notes-body muted-note">No notes added for this fin.</div>';
  const showSummaryCard = Boolean(values.reg) && !editing;
  const summaryCardHtml = showSummaryCard
    ? `
      <button class="fin-summary-card fin-location-card" data-fin-location type="button" aria-label="Open live flight details">
        <div class="metric-label">Live location</div>
        <div class="fin-location-value" data-fin-location-display>Checking position…</div>
        <div class="fin-location-meta">
          <span class="dot" aria-hidden="true"></span>
          <span data-fin-location-status aria-live="polite">Fetching FlightRadar24 data…</span>
        </div>
      </button>
    `
    : '';
  const actions = editing
    ? `
      <button type="button" class="btn" data-fin-action="save">Save fin</button>
      <button type="button" class="btn btn-secondary" data-fin-action="cancel">Cancel</button>
      <button type="button" class="btn btn-secondary btn-danger" data-fin-action="delete" ${deleteDisabled}>Delete fin</button>
    `
    : `
      <button type="button" class="btn" data-fin-action="edit">Edit fin</button>
      <button type="button" class="btn btn-secondary btn-danger" data-fin-action="delete" ${deleteDisabled}>Delete fin</button>
    `;
  outEl.innerHTML = `
    <div class="fin-viewer ${editing ? 'is-editing' : ''}" data-fin-form>
      <div class="metric-grid fin-card-grid">
        ${cards.join('')}
      </div>
      <div class="fin-notes-card fin-card">
        <h4>Notes</h4>
        <div class="fin-field-display">${notesBody}</div>
        <div class="fin-field-edit">
          <textarea data-fin-field="notes" rows="3" maxlength="2000" placeholder="Add reference info or reminders for this fin">${escapeHtml(values.notes)}</textarea>
        </div>
      </div>
      ${summaryCardHtml}
      <div class="fin-actions">
        ${actions}
      </div>
      <div class="wx-error hidden" data-fin-error></div>
    </div>
  `;
  outEl.dataset.finRegistration = values.reg || '';
  const summaryCard = outEl.querySelector('[data-fin-location]');
  if (summaryCard){
    hydrateFinLocation(outEl, fin, values.reg);
  }
}

function attachFinLookup({ inputId, outId }){
  const input = document.getElementById(inputId);
  const out = document.getElementById(outId);
  if (!out) return;
  const update = () => renderFinResult(out, input?.value?.trim() ?? '');
  if (input){
    input.addEventListener('input', update);
    input.addEventListener('change', update);
  }
  if (!out.dataset.finBound){
    addTapListener(out, (event) => {
      const finValue = input?.value?.trim() ?? '';
      const fin = Number(finValue);
      const locationTrigger = event.target?.closest('[data-fin-location]');
      if (locationTrigger){
        openFinHiddenPage('flight', { fin, registration: out.dataset.finRegistration || '' });
        return;
      }
      const action = event.target?.closest('[data-fin-action]')?.dataset?.finAction;
      if (!action) return;
      const form = out.querySelector('[data-fin-form]');
      if (!form) return;
      const errorEl = form.querySelector('[data-fin-error]');
      if (errorEl) errorEl.classList.add('hidden');
      if (action === 'add'){
        form.classList.remove('hidden');
        return;
      }
      if (action === 'edit'){
        out.dataset.finEditing = 'true';
        renderFinResult(out, finValue);
        out.querySelector('[data-fin-field="type"]')?.focus();
        return;
      }
      if (action === 'cancel'){
        out.dataset.finEditing = 'false';
        renderFinResult(out, finValue);
        return;
      }
      if (action === 'restore'){
        out.dataset.finEditing = 'false';
        removeCustomFinConfig(fin);
        renderFinResult(out, finValue);
        return;
      }
      if (action === 'delete'){
        out.dataset.finEditing = 'false';
        const custom = findCustomFinConfig(fin);
        const isCustom = Boolean(custom && !custom.deleted);
        openFinDeleteOverlay(fin, { isCustom });
        return;
      }
      if (action === 'save'){
        const data = getFinFormData(form);
        const error = validateFinConfig(data);
        if (error){
          if (errorEl){
            errorEl.textContent = error;
            errorEl.classList.remove('hidden');
          }
          return;
        }
        upsertCustomFinConfig(data, fin);
        out.dataset.finEditing = 'false';
        renderFinResult(out, finValue);
      }
    });
    out.dataset.finBound = 'true';
  }
  update();
}

function refreshFinResults(){
  const finOut = document.getElementById('fin-out');
  const finInput = document.getElementById('fin-input');
  if (finOut){
    renderFinResult(finOut, finInput?.value?.trim() ?? '');
  }
  const modernFinOut = document.getElementById('modern-fin-out');
  const modernFinInput = document.getElementById('modern-fin-input');
  if (modernFinOut){
    renderFinResult(modernFinOut, modernFinInput?.value?.trim() ?? '');
  }
}

let calendarState = {
  eventsByDate: {},
  months: [],
  selectedMonth: null
};

function loadCalendarState(){
  try {
    const stored = JSON.parse(localStorage.getItem(CALENDAR_STORAGE_KEY) || '{}');
    if (!stored || typeof stored !== 'object') return;
    calendarState = {
      eventsByDate: stored.eventsByDate || {},
      months: Array.isArray(stored.months) ? stored.months : [],
      selectedMonth: stored.selectedMonth || null
    };
  } catch (err){
    console.warn('Failed to load calendar schedule', err);
  }
  try {
    const prefs = JSON.parse(localStorage.getItem(CALENDAR_PREFS_KEY) || '{}');
    if (prefs?.selectedMonth){
      calendarState.selectedMonth = prefs.selectedMonth;
    }
  } catch (err){
    console.warn('Failed to load calendar prefs', err);
  }
}

function saveCalendarState(){
  const payload = {
    eventsByDate: calendarState.eventsByDate,
    months: calendarState.months,
    selectedMonth: calendarState.selectedMonth
  };
  try {
    localStorage.setItem(CALENDAR_STORAGE_KEY, JSON.stringify(payload));
    localStorage.setItem(CALENDAR_PREFS_KEY, JSON.stringify({ selectedMonth: calendarState.selectedMonth }));
  } catch (err){
    console.warn('Failed to save calendar schedule', err);
  }
}

function buildCalendarMonths(eventsByDate){
  const months = new Set();
  Object.keys(eventsByDate || {}).forEach((dateKey) => {
    if (typeof dateKey === 'string' && dateKey.length >= 7){
      months.add(dateKey.slice(0, 7));
    }
  });
  return Array.from(months).sort();
}

function getCalendarMonthKey(date){
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function formatCalendarMonthLabel(monthKey){
  if (!monthKey) return 'Month';
  const [year, month] = monthKey.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return 'Month';
  return new Date(year, month - 1, 1).toLocaleString('en', { month: 'long', year: 'numeric' });
}

function parseDateFromLine(line, fallbackYear){
  const dateMatch = line.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+([A-Za-z]{3})\s*(\d{4})?/i)
    || line.match(/\b(\d{1,2})\s+([A-Za-z]{3})\s*(\d{4})?/i);
  if (!dateMatch) return null;
  const day = Number(dateMatch[1]);
  const monthName = dateMatch[2];
  const year = Number(dateMatch[3] || fallbackYear);
  if (!Number.isFinite(day) || !Number.isFinite(year)) return null;
  const monthIndex = new Date(`${monthName} 1, ${year}`).getMonth();
  if (!Number.isFinite(monthIndex)) return null;
  const date = new Date(year, monthIndex, day);
  if (!Number.isFinite(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dayLabel = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${dayLabel}`;
}

function inferYearFromLines(lines){
  const combined = lines.join(' ');
  const yearMatch = combined.match(/\b(20\d{2})\b/);
  if (yearMatch) return Number(yearMatch[1]);
  return new Date().getFullYear();
}

function extractDurationFromLine(line, keywords){
  const label = keywords.join('|');
  const regex = new RegExp(`\\b(?:${label})\\b\\s*[:\\-]?\\s*(\\d{1,3}:\\d{2}|\\d+(?:\\.\\d+)?)`, 'i');
  const match = line.match(regex);
  if (!match) return NaN;
  return parseDurationToMinutes(match[1]);
}

function extractLegsFromLine(line){
  const codes = line.match(/\b[A-Z]{3,4}\b/g) || [];
  const stop = new Set(['PAIR', 'PAIRING', 'DUTY', 'CREDIT', 'CR', 'CNX', 'PP', 'UTC', 'GMT', 'LCL', 'LT', 'STD', 'STA', 'ATD', 'ATA']);
  const filtered = codes.filter(code => !stop.has(code));
  const legs = [];
  for (let i = 0; i < filtered.length - 1; i += 1){
    legs.push({ from: filtered[i], to: filtered[i + 1] });
  }
  return legs;
}

function extractCancellationStatus(line){
  if (/\bCNX\s+PP\b/i.test(line)) return 'CNX PP';
  if (/\bCNX\b/i.test(line)) return 'CNX';
  return null;
}

function extractIdentifiersFromLine(line){
  const identifiers = [];
  const pairingMatch = line.match(/\b(?:Pairing|Pair)\s*#?\s*([A-Z0-9]{2,6})\b/i);
  if (pairingMatch){
    identifiers.push(`Pairing ${pairingMatch[1]}`);
  }
  const flightMatches = line.match(/\b[A-Z]{2,3}\d{1,4}\b/g) || [];
  flightMatches.forEach((match) => {
    if (!identifiers.includes(match)) identifiers.push(match);
  });
  return identifiers;
}

function buildLinesFromTextContent(textContent){
  const items = textContent?.items || [];
  const lines = [];
  let currentY = null;
  let currentLine = [];
  items.forEach((item) => {
    const text = String(item?.str || '').trim();
    if (!text) return;
    const y = Math.round(item?.transform?.[5] || 0);
    if (currentY === null) currentY = y;
    if (Math.abs(y - currentY) > 2){
      if (currentLine.length){
        lines.push(currentLine.join(' ').replace(/\s+/g, ' ').trim());
      }
      currentLine = [];
      currentY = y;
    }
    currentLine.push(text);
  });
  if (currentLine.length){
    lines.push(currentLine.join(' ').replace(/\s+/g, ' ').trim());
  }
  return lines;
}

function parseScheduleLines(lines){
  const year = inferYearFromLines(lines);
  const eventsByDate = {};
  const pendingCancellations = [];
  let currentDate = null;
  let inDutyPlan = false;
  let inAdditional = false;
  const hasHeaders = lines.some(line => /Individual duty plan|Additional Details/i.test(line));
  let fallbackMatches = 0;
  const addDutyEventFromLine = (line, dateKey) => {
    if (!eventsByDate[dateKey]) eventsByDate[dateKey] = { events: [] };
    const identifiers = extractIdentifiersFromLine(line);
    if (!identifiers.length) return false;
    const dutyMinutes = extractDurationFromLine(line, ['Duty']);
    const creditMinutes = extractDurationFromLine(line, ['Credit', 'CR']);
    const legs = extractLegsFromLine(line);
    const cancellation = extractCancellationStatus(line);
    const label = identifiers.join(', ');
    const eventId = `${dateKey}-${eventsByDate[dateKey].events.length}-${label.replace(/\s+/g, '')}`;
    eventsByDate[dateKey].events.push({
      id: eventId,
      date: dateKey,
      label,
      identifiers,
      dutyMinutes: Number.isFinite(dutyMinutes) ? dutyMinutes : null,
      creditMinutes: Number.isFinite(creditMinutes) ? creditMinutes : null,
      legs,
      cancellation
    });
    return true;
  };
  if (!hasHeaders){
    lines.forEach((line) => {
      const dateKey = parseDateFromLine(line, year);
      if (dateKey){
        currentDate = dateKey;
        if (!eventsByDate[currentDate]) eventsByDate[currentDate] = { events: [] };
      }
      if (!currentDate) return;
      const added = addDutyEventFromLine(line, currentDate);
      if (added) fallbackMatches += 1;
    });
    return {
      eventsByDate,
      statusMessage: fallbackMatches ? '' : 'PDF format not recognized.'
    };
  }
  lines.forEach((line) => {
    if (/Individual duty plan/i.test(line)){
      inDutyPlan = true;
      inAdditional = false;
      return;
    }
    if (/Additional Details/i.test(line)){
      inAdditional = true;
      inDutyPlan = false;
      return;
    }
    if (!inDutyPlan && !inAdditional) return;
    const dateKey = parseDateFromLine(line, year);
    if (dateKey){
      currentDate = dateKey;
      if (!eventsByDate[currentDate]) eventsByDate[currentDate] = { events: [] };
    }
    if (!currentDate) return;
    if (inDutyPlan){
      addDutyEventFromLine(line, currentDate);
    } else if (inAdditional){
      const cancellation = extractCancellationStatus(line);
      if (!cancellation) return;
      const identifiers = extractIdentifiersFromLine(line);
      if (!identifiers.length) return;
      const targetDate = parseDateFromLine(line, year) || currentDate;
      pendingCancellations.push({ date: targetDate, identifiers, cancellation });
    }
  });
  pendingCancellations.forEach(({ date, identifiers, cancellation }) => {
    const day = eventsByDate[date];
    if (!day) return;
    day.events.forEach((event) => {
      if (event.identifiers.some(id => identifiers.includes(id))){
        event.cancellation = cancellation;
      }
    });
  });
  return { eventsByDate, statusMessage: '' };
}

async function parseSchedulePdf(file){
  if (!window.pdfjsLib){
    throw new Error('PDF parser unavailable.');
  }
  if (window.pdfjsLib.GlobalWorkerOptions){
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
  }
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  const lines = [];
  for (let i = 1; i <= pdf.numPages; i += 1){
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    lines.push(...buildLinesFromTextContent(textContent));
  }
  return parseScheduleLines(lines);
}

function getCalendarMonthCandidates(){
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const months = new Set(calendarState.months);
  months.add(getCalendarMonthKey(now));
  months.add(getCalendarMonthKey(nextMonth));
  return Array.from(months).sort();
}

function ensureCalendarSelection(){
  const months = getCalendarMonthCandidates();
  if (!calendarState.selectedMonth || !months.includes(calendarState.selectedMonth)){
    calendarState.selectedMonth = months[0];
  }
}

function updateCalendarTotals(events){
  let creditMinutes = 0;
  let dutyMinutes = 0;
  let eventCount = 0;
  events.forEach((event) => {
    if (!event) return;
    const isCancelled = event.cancellation === 'CNX';
    if (!isCancelled){
      if (Number.isFinite(event.creditMinutes)) creditMinutes += event.creditMinutes;
      if (Number.isFinite(event.dutyMinutes)) dutyMinutes += event.dutyMinutes;
    }
    eventCount += 1;
  });
  const creditEl = document.getElementById('modern-calendar-total-credit');
  const dutyEl = document.getElementById('modern-calendar-total-duty');
  const eventsEl = document.getElementById('modern-calendar-total-events');
  if (creditEl) creditEl.textContent = formatDurationMinutes(creditMinutes);
  if (dutyEl) dutyEl.textContent = formatDurationMinutes(dutyMinutes);
  if (eventsEl) eventsEl.textContent = String(eventCount);
}

function renderCalendar(){
  const monthSelect = document.getElementById('modern-calendar-month');
  const headerEl = document.getElementById('modern-calendar-summary-header');
  const gridEl = document.getElementById('modern-calendar-grid');
  const statusEl = document.getElementById('modern-calendar-status');
  if (!monthSelect || !gridEl || !headerEl) return;
  calendarState.months = buildCalendarMonths(calendarState.eventsByDate);
  ensureCalendarSelection();
  const monthOptions = getCalendarMonthCandidates();
  monthSelect.innerHTML = '';
  monthOptions.forEach((month) => {
    const option = document.createElement('option');
    option.value = month;
    option.textContent = formatCalendarMonthLabel(month);
    monthSelect.appendChild(option);
  });
  monthSelect.value = calendarState.selectedMonth || monthOptions[0] || '';
  headerEl.textContent = formatCalendarMonthLabel(calendarState.selectedMonth);
  const [year, month] = (calendarState.selectedMonth || '').split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)){
    gridEl.innerHTML = '';
    updateCalendarTotals([]);
    if (statusEl) statusEl.textContent = 'No schedule loaded.';
    return;
  }
  const events = [];
  Object.entries(calendarState.eventsByDate || {}).forEach(([dateKey, day]) => {
    if (dateKey.startsWith(`${year}-${String(month).padStart(2, '0')}`)){
      day?.events?.forEach(event => events.push(event));
    }
  });
  updateCalendarTotals(events);
  if (statusEl){
    statusEl.textContent = events.length ? '' : 'No schedule loaded.';
  }
  const firstOfMonth = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  gridEl.innerHTML = '';
  CALENDAR_WEEKDAYS.forEach((weekday) => {
    const label = document.createElement('div');
    label.className = 'calendar-weekday';
    label.textContent = weekday;
    gridEl.appendChild(label);
  });
  for (let i = 0; i < firstOfMonth.getDay(); i += 1){
    const empty = document.createElement('div');
    empty.className = 'calendar-day is-empty';
    gridEl.appendChild(empty);
  }
  for (let day = 1; day <= daysInMonth; day += 1){
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayEvents = calendarState.eventsByDate?.[dateKey]?.events || [];
    const dayCell = document.createElement('div');
    dayCell.className = 'calendar-day';
    const dayNumber = document.createElement('div');
    dayNumber.className = 'calendar-day-number';
    dayNumber.textContent = String(day);
    dayCell.appendChild(dayNumber);
    dayEvents.forEach((event) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'calendar-event-item';
      wrapper.dataset.eventId = event.id;
      const eventBtn = document.createElement('button');
      eventBtn.type = 'button';
      eventBtn.className = 'calendar-event';
      if (event.cancellation === 'CNX') eventBtn.classList.add('is-cnx');
      const title = document.createElement('div');
      title.className = 'calendar-event-title';
      title.textContent = event.label;
      if (event.cancellation){
        const status = document.createElement('span');
        status.className = 'calendar-event-status';
        status.textContent = event.cancellation;
        if (event.cancellation === 'CNX PP') status.classList.add('is-pp');
        title.appendChild(document.createTextNode(' '));
        title.appendChild(status);
      }
      const meta = document.createElement('div');
      meta.className = 'calendar-event-meta';
      const parts = [];
      if (Number.isFinite(event.creditMinutes)) parts.push(`Credit ${formatDurationMinutes(event.creditMinutes)}`);
      if (Number.isFinite(event.dutyMinutes)) parts.push(`Duty ${formatDurationMinutes(event.dutyMinutes)}`);
      if (event.legs?.length){
        const legsLabel = event.legs.map(leg => `${leg.from}-${leg.to}`).join(' ');
        if (legsLabel) parts.push(legsLabel);
      }
      meta.textContent = parts.join(' · ');
      eventBtn.appendChild(title);
      if (meta.textContent) eventBtn.appendChild(meta);
      wrapper.appendChild(eventBtn);
      const menu = document.createElement('div');
      menu.className = 'calendar-cnx-menu hidden';
      ['CNX', 'CNX PP'].forEach((status) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'calendar-cnx-option';
        option.dataset.cnxStatus = status;
        option.textContent = status;
        if (event.cancellation === status) option.classList.add('active');
        menu.appendChild(option);
      });
      wrapper.appendChild(menu);
      dayCell.appendChild(wrapper);
    });
    if (dayEvents.length){
      let dayCredit = 0;
      let dayDuty = 0;
      dayEvents.forEach((event) => {
        if (event.cancellation === 'CNX') return;
        if (Number.isFinite(event.creditMinutes)) dayCredit += event.creditMinutes;
        if (Number.isFinite(event.dutyMinutes)) dayDuty += event.dutyMinutes;
      });
      const totalParts = [];
      if (dayCredit) totalParts.push(`C ${formatDurationMinutes(dayCredit)}`);
      if (dayDuty) totalParts.push(`D ${formatDurationMinutes(dayDuty)}`);
      if (totalParts.length){
        const total = document.createElement('div');
        total.className = 'calendar-day-total';
        total.textContent = totalParts.join(' · ');
        dayCell.appendChild(total);
      }
    }
    gridEl.appendChild(dayCell);
  }
}

function setCalendarEventCancellation(eventId, status){
  let updated = false;
  Object.values(calendarState.eventsByDate || {}).forEach((day) => {
    day?.events?.forEach((event) => {
      if (event.id === eventId){
        event.cancellation = event.cancellation === status ? null : status;
        updated = true;
      }
    });
  });
  if (updated){
    saveCalendarState();
    renderCalendar();
  }
}

function initCalendar(){
  loadCalendarState();
  renderCalendar();
  const fileInput = document.getElementById('modern-calendar-file');
  if (fileInput){
    fileInput.addEventListener('change', async (event) => {
      const statusEl = document.getElementById('modern-calendar-status');
      const file = event.target?.files?.[0];
      if (!file) return;
      if (statusEl) statusEl.textContent = 'Parsing PDF…';
      try {
        const { eventsByDate, statusMessage } = await parseSchedulePdf(file);
        const parsedMonths = buildCalendarMonths(eventsByDate);
        if (!parsedMonths.length){
          if (statusEl) statusEl.textContent = statusMessage || 'No calendar events found in PDF.';
          return;
        }
        calendarState.eventsByDate = eventsByDate;
        calendarState.months = parsedMonths;
        ensureCalendarSelection();
        saveCalendarState();
        renderCalendar();
        if (statusEl){
          const label = parsedMonths.length === 1 ? 'month' : 'months';
          statusEl.textContent = `Loaded schedule for ${parsedMonths.length} ${label}.`;
        }
      } catch (err){
        console.error('PDF schedule parse failed', err);
        if (statusEl) statusEl.textContent = 'PDF parse failed.';
      } finally {
        event.target.value = '';
      }
    });
  }
  const monthSelect = document.getElementById('modern-calendar-month');
  if (monthSelect){
    monthSelect.addEventListener('change', () => {
      calendarState.selectedMonth = monthSelect.value;
      saveCalendarState();
      renderCalendar();
    });
  }
  const grid = document.getElementById('modern-calendar-grid');
  if (grid){
    grid.addEventListener('click', (event) => {
      const target = event.target;
      const statusButton = target instanceof Element ? target.closest('[data-cnx-status]') : null;
      if (statusButton){
        const wrapper = statusButton.closest('[data-event-id]');
        const eventId = wrapper?.dataset?.eventId;
        if (eventId) setCalendarEventCancellation(eventId, statusButton.dataset.cnxStatus);
        return;
      }
      const eventButton = target instanceof Element ? target.closest('.calendar-event') : null;
      if (eventButton){
        const wrapper = eventButton.closest('[data-event-id]');
        if (!wrapper) return;
        document.querySelectorAll('.calendar-cnx-menu').forEach((menu) => menu.classList.add('hidden'));
        const menu = wrapper.querySelector('.calendar-cnx-menu');
        if (menu) menu.classList.toggle('hidden');
      }
    });
  }
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('#modern-calendar-grid')) return;
    document.querySelectorAll('.calendar-cnx-menu').forEach((menu) => menu.classList.add('hidden'));
  });
}

let currentLegacySubTab = 'annual';
let currentModernSubTab = 'modern-annual';
let currentLegacyDutyTab = 'duty';
let currentModernDutyTab = 'modern-duty';
let currentModernFinTab = 'modern-fin-qrh';

function setLegacyPrimaryTab(which){
  const payBtn = document.getElementById('tabbtn-pay');
  const weatherBtn = document.getElementById('tabbtn-weather');
  const dutyBtn = document.getElementById('tabbtn-duty-rest');
  const calendarBtn = document.getElementById('tabbtn-calendar');
  const finBtn = document.getElementById('tabbtn-fin');
  const payPane = document.getElementById('legacy-pay');
  const weatherPane = document.getElementById('tab-weather');
  const dutyPane = document.getElementById('tab-duty-rest');
  const calendarPane = document.getElementById('tab-calendar');
  const finPane = document.getElementById('tab-fin');
  const showPay = which === 'pay';
  const showWeather = which === 'weather';
  const showDuty = which === 'duty-rest';
  const showCalendar = which === 'calendar';
  const showFin = which === 'fin';
  payBtn?.classList.toggle('active', showPay);
  weatherBtn?.classList.toggle('active', showWeather);
  dutyBtn?.classList.toggle('active', showDuty);
  calendarBtn?.classList.toggle('active', showCalendar);
  finBtn?.classList.toggle('active', showFin);
  payPane?.classList.toggle('hidden', !showPay);
  weatherPane?.classList.toggle('hidden', !showWeather);
  dutyPane?.classList.toggle('hidden', !showDuty);
  calendarPane?.classList.toggle('hidden', !showCalendar);
  finPane?.classList.toggle('hidden', !showFin);
  if (showPay) setLegacySubTab(currentLegacySubTab);
  if (showDuty) setLegacyDutyTab(currentLegacyDutyTab);
}

function setLegacySubTab(which){
  currentLegacySubTab = which;
  const tabs = [
    { btn: 'tabbtn-annual', pane: 'tab-annual', id: 'annual' },
    { btn: 'tabbtn-monthly', pane: 'tab-monthly', id: 'monthly' },
    { btn: 'tabbtn-vo', pane: 'tab-vo', id: 'vo' },
    { btn: null, pane: 'tab-annual-advanced', id: 'annual-advanced' }
  ];
  tabs.forEach(({ btn, pane, id }) => {
    const b = btn ? document.getElementById(btn) : null;
    const p = document.getElementById(pane);
    if (!p) return;
    if (which === id){
      if (b) b.classList.add('active');
      p.classList.remove('hidden');
    } else {
      if (b) b.classList.remove('active');
      p.classList.add('hidden');
    }
  });
}

function setLegacyDutyTab(which){
  currentLegacyDutyTab = which;
  const tabs = [
    { btn: 'tabbtn-duty', pane: 'tab-duty', id: 'duty' },
    { btn: 'tabbtn-rest', pane: 'tab-rest', id: 'rest' },
    { btn: 'tabbtn-time-converter', pane: 'tab-time-converter', id: 'time-converter' },
    { btn: 'tabbtn-time-calculator', pane: 'tab-time-calculator', id: 'time-calculator' }
  ];
  tabs.forEach(({ btn, pane, id }) => {
    const b = document.getElementById(btn);
    const p = document.getElementById(pane);
    if (!b || !p) return;
    if (which === id){
      b.classList.add('active');
      p.classList.remove('hidden');
    } else {
      b.classList.remove('active');
      p.classList.add('hidden');
    }
  });
}

function setModernPrimaryTab(which){
  const payBtn = document.getElementById('tabbtn-modern-pay');
  const weatherBtn = document.getElementById('tabbtn-modern-weather');
  const dutyBtn = document.getElementById('tabbtn-modern-duty-rest');
  const calendarBtn = document.getElementById('tabbtn-modern-calendar');
  const finBtn = document.getElementById('tabbtn-modern-fin');
  const payPane = document.getElementById('modern-pay');
  const weatherPane = document.getElementById('modern-weather');
  const metarHistoryPane = document.getElementById('modern-metar-history');
  const dutyPane = document.getElementById('modern-duty-rest');
  const calendarPane = document.getElementById('modern-calendar');
  const finPane = document.getElementById('modern-fin');
  const finHiddenPane = document.getElementById('modern-fin-hidden');
  const showPay = which === 'modern-pay';
  const showWeather = which === 'modern-weather';
  const showMetarHistory = which === 'modern-metar-history';
  const showWeatherTab = showWeather || showMetarHistory;
  const showDuty = which === 'modern-duty-rest';
  const showCalendar = which === 'modern-calendar';
  const showFin = which === 'modern-fin';
  const showingHiddenFin = showFin && finHiddenContext.page !== null;
  payBtn?.classList.toggle('active', showPay);
  weatherBtn?.classList.toggle('active', showWeatherTab);
  dutyBtn?.classList.toggle('active', showDuty);
  calendarBtn?.classList.toggle('active', showCalendar);
  finBtn?.classList.toggle('active', showFin);
  payPane?.classList.toggle('hidden', !showPay);
  weatherPane?.classList.toggle('hidden', !showWeather);
  metarHistoryPane?.classList.toggle('hidden', !showMetarHistory);
  dutyPane?.classList.toggle('hidden', !showDuty);
  calendarPane?.classList.toggle('hidden', !showCalendar);
  finPane?.classList.toggle('hidden', !showFin || showingHiddenFin);
  finHiddenPane?.classList.toggle('hidden', !showFin || !showingHiddenFin);
  if (!showMetarHistory){
    const metarPage = document.getElementById('metar-history-page');
    if (metarPage){
      metarPage.classList.add('hidden');
      metarPage.setAttribute('aria-hidden', 'true');
    }
  }
  if (showPay) setModernSubTab(currentModernSubTab);
  if (showDuty) setModernDutyTab(currentModernDutyTab);
  if (showFin && !showingHiddenFin) setModernFinTab(currentModernFinTab);
}

function setModernSubTab(which){
  currentModernSubTab = which;
  const tabs = [
    { id: 'modern-annual', btn: 'tabbtn-modern-annual' },
    { id: 'modern-monthly', btn: 'tabbtn-modern-monthly' },
    { id: 'modern-vo', btn: 'tabbtn-modern-vo' },
    { id: 'modern-annual-advanced', btn: null }
  ];
  tabs.forEach(({ id, btn }) => {
    const button = btn ? document.getElementById(btn) : null;
    const pane = document.getElementById(id);
    if (!pane) return;
    if (id === which){
      if (button) button.classList.add('active');
      pane.classList.remove('hidden');
    } else {
      if (button) button.classList.remove('active');
      pane.classList.add('hidden');
    }
  });
  updateProjectionControlsVisibility();
}

function setModernDutyTab(which){
  currentModernDutyTab = which;
  const tabs = ['modern-duty','modern-rest','modern-time-converter','modern-time-calculator'];
  tabs.forEach(id => {
    const btn = document.getElementById(`tabbtn-${id}`);
    const pane = document.getElementById(id);
    if (!btn || !pane) return;
    if (id === which){
      btn.classList.add('active');
      pane.classList.remove('hidden');
    } else {
      btn.classList.remove('active');
      pane.classList.add('hidden');
    }
  });
}

function setModernFinTab(which){
  currentModernFinTab = which;
  const tabs = ['modern-fin-qrh', 'modern-flight-number'];
  tabs.forEach((id) => {
    const btn = document.getElementById(`tabbtn-${id}`);
    const pane = document.getElementById(id);
    if (!pane) return;
    const isActive = id === which;
    if (btn) btn.classList.toggle('active', isActive);
    pane.classList.toggle('hidden', !isActive);
  });
}

function openFinHiddenPage(page, { fin, registration } = {}){
  const normalizedReg = normalizeRegistration(registration);
  finHiddenContext.page = page;
  finHiddenContext.fin = Number.isFinite(fin) ? fin : null;
  finHiddenContext.registration = normalizedReg || '';
  const title = document.getElementById('fin-hidden-title');
  const mainPane = document.getElementById('modern-fin');
  const hiddenPane = document.getElementById('modern-fin-hidden');
  document.querySelectorAll('[data-fin-hidden-page]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.finHiddenPage !== page);
  });
  if (title){
    if (page === 'api'){
      title.textContent = 'FlightRadar24 API';
    } else if (page === 'flight'){
      const prefix = finHiddenContext.fin ? `Fin ${finHiddenContext.fin}` : 'Live flight';
      title.textContent = `${prefix} details`;
    } else {
      title.textContent = 'Fin tools';
    }
  }
  if (mainPane && hiddenPane){
    mainPane.classList.add('hidden');
    hiddenPane.classList.remove('hidden');
  }
  if (page === 'api'){
    populateFr24ConfigForm();
  }
  if (page === 'flight'){
    refreshFinCodeToggleButtons();
    loadFinFlightDetails(finHiddenContext.registration);
  }
}

function closeFinHiddenPage(){
  finHiddenContext.page = null;
  finHiddenContext.fin = null;
  finHiddenContext.registration = '';
  const mainPane = document.getElementById('modern-fin');
  const hiddenPane = document.getElementById('modern-fin-hidden');
  if (mainPane) mainPane.classList.remove('hidden');
  if (hiddenPane) hiddenPane.classList.add('hidden');
}

async function loadFinFlightDetails(registration, { forceRefresh = false } = {}){
  const normalizedReg = normalizeRegistration(registration);
  finHiddenContext.registration = normalizedReg || '';
  const statusEl = document.getElementById('fin-flight-status');
  const currentEl = document.getElementById('fin-flight-current');
  const recentEl = document.getElementById('fin-flight-recent');
  const cachedFlights = normalizedReg ? FIN_FLIGHT_CACHE.get(normalizedReg)?.flights || [] : [];
  const cachedSnapshot = buildFinLocationSnapshot(cachedFlights);
  renderFinCurrentFlight(currentEl, cachedSnapshot);
  renderFinFlightList(recentEl, cachedSnapshot.flights, { hideActive: cachedSnapshot.inflight });
  if (!normalizedReg){
    if (statusEl) statusEl.textContent = 'Add a registration to track this fin.';
    return;
  }
  const refreshLiveFromCache = async (snapshot) => {
    updateFinFlightPage(normalizedReg);
    const liveCache = FIN_LIVE_POSITION_CACHE.get(normalizedReg);
    if (snapshot.inflight && !(liveCache?.positions?.length)){
      await loadFinLivePositions(normalizedReg, snapshot);
    }
  };
  if (cachedFlights.length && !forceRefresh){
    if (statusEl) statusEl.textContent = 'Showing cached data.';
    await refreshLiveFromCache(cachedSnapshot);
    return;
  }
  if (statusEl) statusEl.textContent = 'Fetching live data…';
  try {
    const { flights, registration: regOut } = await fetchFr24FlightSummary(normalizedReg);
    cacheFinFlights(regOut, flights);
    updateFinFlightPage(regOut);
    const snapshot = buildFinLocationSnapshot(flights);
    if (snapshot.inflight){
      await loadFinLivePositions(regOut, snapshot);
    }
  } catch (err){
    if (statusEl){
      const friendly = err?.message && err.message !== 'Failed to fetch'
        ? err.message
        : 'Live flight data unavailable right now.';
      statusEl.textContent = friendly;
    }
  }
}

function extractUtcTimeValue(label){
  const match = String(label || '').match(/(\d{2}:\d{2})/);
  return match ? match[1] : '';
}

function convertFdpEndToTimeConverter(endUtcText, isModern){
  const utcValue = extractUtcTimeValue(endUtcText);
  if (!utcValue) return;
  if (isModern){
    setModernPrimaryTab('modern-duty-rest');
    setModernDutyTab('modern-time-converter');
    const utcEl = document.getElementById('modern-time-utc');
    if (utcEl){
      utcEl.value = utcValue;
      utcEl.dispatchEvent(new Event('input', { bubbles: true }));
      utcEl.focus();
    }
  } else {
    setLegacyPrimaryTab('duty-rest');
    setLegacyDutyTab('time-converter');
    const utcEl = document.getElementById('time-utc');
    if (utcEl){
      utcEl.value = utcValue;
      utcEl.dispatchEvent(new Event('input', { bubbles: true }));
      utcEl.focus();
    }
  }
}

function toggleDutyFields(typeId, unaugId, augId){
  const typeEl = document.getElementById(typeId);
  const unaug = document.getElementById(unaugId);
  const aug = document.getElementById(augId);
  if (!typeEl) return;
  const isAug = typeEl.value === 'augmented';
  if (unaug) {
    unaug.classList.toggle('hidden', isAug);
    unaug.setAttribute('aria-hidden', String(isAug));
  }
  if (aug) {
    aug.classList.toggle('hidden', !isAug);
    aug.setAttribute('aria-hidden', String(!isAug));
    aug.querySelectorAll('input, select, textarea').forEach((field) => {
      field.disabled = !isAug;
    });
  }
}

function toggleDutyModeFields(modeId, scopeId){
  const modeEl = document.getElementById(modeId);
  const scopeEl = scopeId ? document.getElementById(scopeId) : document;
  if (!modeEl || !scopeEl) return;
  const isFom = modeEl.value === 'fom';
  scopeEl.querySelectorAll('[data-duty-mode="alpa"]').forEach((el) => {
    el.classList.toggle('hidden', isFom);
    el.setAttribute('aria-hidden', String(isFom));
  });
}

function updateAugmentedFacilityOptions(crewId, facilityId){
  const crewEl = document.getElementById(crewId);
  const facilityEl = document.getElementById(facilityId);
  if (!crewEl || !facilityEl) return;
  const crewType = normalizeCrewType(crewEl.value);
  const modeEl = crewId.startsWith('modern')
    ? document.getElementById('modern-duty-mode')
    : document.getElementById('duty-mode');
  const dutyMode = modeEl?.value === 'fom' ? 'fom' : 'alpa';
  const allowed = dutyMode === 'fom' ? [1, 2, 3] : (crewType === 'basic+1' ? [1, 2, 3] : [1]);
  const current = Number(facilityEl.value);
  facilityEl.querySelectorAll('option').forEach(option => {
    const value = Number(option.value);
    const enabled = allowed.includes(value);
    option.disabled = !enabled;
    option.hidden = !enabled;
  });
  if (!allowed.includes(current)) {
    facilityEl.value = String(allowed[0]);
  }
}

function toggleRestFields(typeId, unaugId){
  const typeEl = document.getElementById(typeId);
  const unaug = document.getElementById(unaugId);
  if (!typeEl || !unaug) return;
  const isAug = typeEl.value === 'augmented';
  unaug.classList.toggle('hidden', isAug);
}

function onSeatChange(isVO){
  const seat = (isVO? document.getElementById('ot-seat').value : document.getElementById('seat').value);
  const acSel = isVO? document.getElementById('ot-ac') : document.getElementById('ac');
  updateAircraftOptions(seat, acSel);
}
// Seat change for Monthly tab
function onSeatChangeMonthly(){
  const seat = document.getElementById('mon-seat').value;
  const acSel = document.getElementById('mon-ac');
  updateAircraftOptions(seat, acSel);
}

function onSeatChangeModern(){
  const seat = document.getElementById('modern-seat')?.value;
  const acSel = document.getElementById('modern-ac');
  updateAircraftOptions(seat, acSel);
}
function onSeatChangeModernMonthly(){
  const seat = document.getElementById('modern-mon-seat')?.value;
  const acSel = document.getElementById('modern-mon-ac');
  updateAircraftOptions(seat, acSel);
}
function onSeatChangeModernVO(){
  const seat = document.getElementById('modern-ot-seat')?.value;
  const acSel = document.getElementById('modern-ot-ac');
  updateAircraftOptions(seat, acSel);
}
function tieYearStepFromYear(isVO){
  const tie = (isVO? document.getElementById('ot-tie') : document.getElementById('tie')).checked;
  if (!tie) return;
  const yearEl = isVO? document.getElementById('ot-year') : document.getElementById('year');
  const stepEl = isVO? document.getElementById('ot-step') : document.getElementById('step');
  const y = +yearEl.value;
  stepEl.value = String(Math.max(1, Math.min(12, (y-2025)+1)));
}
function tieYearStepFromStep(isVO){
  const tie = (isVO? document.getElementById('ot-tie') : document.getElementById('tie')).checked;
  if (!tie) return;
  const yearEl = isVO? document.getElementById('ot-year') : document.getElementById('year');
  const stepEl = isVO? document.getElementById('ot-step') : document.getElementById('step');
  const s = Math.max(1, Math.min(12, +stepEl.value));
  yearEl.value = String(Math.max(2023, Math.min(2031, 2024 + s)));
}
// Tie logic for Monthly tab
function tieYearStepFromYearMonthly(){
  const tie = document.getElementById('mon-tie').checked;
  if (!tie) return;
  const yearEl = document.getElementById('mon-year');
  const stepEl = document.getElementById('mon-step');
  const y = +yearEl.value;
  stepEl.value = String(Math.max(1, Math.min(12, (y-2025)+1)));
}
function tieYearStepFromStepMonthly(){
  const tie = document.getElementById('mon-tie').checked;
  if (!tie) return;
  const yearEl = document.getElementById('mon-year');
  const stepEl = document.getElementById('mon-step');
  const s = Math.max(1, Math.min(12, +stepEl.value));
  yearEl.value = String(Math.max(2023, Math.min(2031, 2024 + s)));
}

function tieYearStepFromYearModern(){
  const tie = document.getElementById('modern-tie')?.checked;
  if (!tie) return;
  const yearEl = document.getElementById('modern-year');
  const stepEl = document.getElementById('modern-step');
  if (!yearEl || !stepEl) return;
  const y = +yearEl.value;
  stepEl.value = String(Math.max(1, Math.min(12, (y-2025)+1)));
}
function tieYearStepFromStepModern(){
  const tie = document.getElementById('modern-tie')?.checked;
  if (!tie) return;
  const yearEl = document.getElementById('modern-year');
  const stepEl = document.getElementById('modern-step');
  if (!yearEl || !stepEl) return;
  const s = Math.max(1, Math.min(12, +stepEl.value));
  yearEl.value = String(Math.max(2023, Math.min(2031, 2024 + s)));
  updateProjectionControlsVisibility();
}
function tieYearStepFromYearModernMonthly(){
  const tie = document.getElementById('modern-mon-tie')?.checked;
  if (!tie) return;
  const yearEl = document.getElementById('modern-mon-year');
  const stepEl = document.getElementById('modern-mon-step');
  if (!yearEl || !stepEl) return;
  const y = +yearEl.value;
  stepEl.value = String(Math.max(1, Math.min(12, (y-2025)+1)));
}
function tieYearStepFromStepModernMonthly(){
  const tie = document.getElementById('modern-mon-tie')?.checked;
  if (!tie) return;
  const yearEl = document.getElementById('modern-mon-year');
  const stepEl = document.getElementById('modern-mon-step');
  if (!yearEl || !stepEl) return;
  const s = Math.max(1, Math.min(12, +stepEl.value));
  yearEl.value = String(Math.max(2023, Math.min(2031, 2024 + s)));
  updateProjectionControlsVisibility();
}
function tieYearStepFromYearModernVO(){
  const tie = document.getElementById('modern-ot-tie')?.checked;
  if (!tie) return;
  const yearEl = document.getElementById('modern-ot-year');
  const stepEl = document.getElementById('modern-ot-step');
  if (!yearEl || !stepEl) return;
  const y = +yearEl.value;
  stepEl.value = String(Math.max(1, Math.min(12, (y-2025)+1)));
}
function tieYearStepFromStepModernVO(){
  const tie = document.getElementById('modern-ot-tie')?.checked;
  if (!tie) return;
  const yearEl = document.getElementById('modern-ot-year');
  const stepEl = document.getElementById('modern-ot-step');
  if (!yearEl || !stepEl) return;
  const s = Math.max(1, Math.min(12, +stepEl.value));
  yearEl.value = String(Math.max(2023, Math.min(2031, 2024 + s)));
  updateProjectionControlsVisibility();
}

// --- Weather helpers (METAR/TAF decoding) ---
function escapeHtml(str=''){
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function shouldForceProxy(url){
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'aviationweather.gov';
  } catch (err){
    return false;
  }
}
function buildCorsTargets(url, forceProxy){
  const unique = [];
  const add = (target) => {
    if (!target) return;
    if (unique.includes(target)) return;
    unique.push(target);
  };
  const alreadyProxied = CORS_PROXY_PREFIXES.some(prefix => url.startsWith(prefix));
  const allowDirect = (!forceProxy || alreadyProxied || WEATHER_ALLOW_DIRECT_FOR_FORCED_PROXY);
  if (allowDirect) add(url);
  if (!alreadyProxied){
    for (const buildProxyUrl of CORS_PROXY_BUILDERS){
      add(buildProxyUrl(url));
    }
    if (forceProxy && WEATHER_ALLOW_DIRECT_FOR_FORCED_PROXY) add(url);
  }
  return unique;
}
async function fetchWithTimeout(target, options, timeoutMs = WEATHER_REQUEST_TIMEOUT_MS){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  try {
    const resp = await fetch(target, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}
async function fetchJsonWithCorsFallback(url, cache='no-store'){
  const attempt = async (target) => {
    const resp = await fetchWithTimeout(target, { cache, mode:'cors' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  };
  const forceProxy = shouldForceProxy(url);
  const targets = buildCorsTargets(url, forceProxy);
  let lastErr = null;
  for (const target of targets){
    try {
      return await attempt(target);
    } catch(err){
      lastErr = err;
      const note = target === url ? 'direct' : 'proxy';
      console.warn(`${note} fetch failed for ${url} via ${target}`, err);
    }
  }
  throw lastErr;
}
async function fetchTextWithCorsFallback(url, cache='no-store'){
  const attempt = async (target) => {
    const resp = await fetchWithTimeout(target, { cache, mode:'cors' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
  };
  const forceProxy = shouldForceProxy(url);
  const targets = buildCorsTargets(url, forceProxy);
  let lastErr = null;
  for (const target of targets){
    try {
      return await attempt(target);
    } catch(err){
      lastErr = err;
      const note = target === url ? 'direct' : 'proxy';
      console.warn(`${note} text fetch failed for ${url} via ${target}`, err);
    }
  }
  throw lastErr;
}
function extractVisibilityToken(tokens){
  if (!Array.isArray(tokens)) return null;
  for (let i = 0; i < tokens.length; i += 1){
    const tok = tokens[i];
    if (!tok) continue;
    if (/^CAVOK$/i.test(tok)) return tok;
    if (/SM$/i.test(tok)){
      const prev = tokens[i - 1];
      if (i > 0 && /^\d+$/.test(prev) && /^M?\d+\/\d+SM$/i.test(tok)){
        return `${prev} ${tok}`;
      }
      return tok;
    }
  }
  const meterToken = tokens.find(t => /^\d{4}$/.test(t));
  return meterToken || null;
}
const CLOUD_LAYER_TOKEN_RE = /^(VV|FEW|SCT|BKN|OVC)\d{3}$/i;
function parseCloudLayerToken(token){
  const text = String(token || '').toUpperCase();
  if (!CLOUD_LAYER_TOKEN_RE.test(text)) return null;
  const isVertVis = text.startsWith('VV');
  const cover = isVertVis ? 'VV' : text.slice(0, 3);
  const baseDigits = isVertVis ? text.slice(2) : text.slice(3);
  return { cover, base: normalizeCloudBaseFt(Number(baseDigits)) };
}
function segmentVisibilityRaw(seg){
  if (!seg) return null;
  const direct = seg.visibRaw ?? seg.visRaw ?? seg.visibility_raw ?? seg.visibilityRaw;
  if (direct !== null && direct !== undefined){
    const text = String(direct).trim();
    return text || null;
  }
  const raw = seg.rawOb || seg.raw_text || seg.rawTAF || seg.text || seg.wxString;
  if (!raw) return null;
  const token = extractVisibilityToken(String(raw).trim().split(/\s+/));
  return token || null;
}
async function fetchMetarTextWithFallbacks(icao){
  for (const buildUrl of METAR_TEXT_FALLBACKS){
    const url = buildUrl(icao);
    try {
      const txt = await fetchTextWithCorsFallback(url, 'no-store');
      if (txt) return parseMetarText(txt, icao);
    } catch(err){
      console.warn(`METAR text fallback failed for ${icao} at ${url}`, err);
    }
  }
  return null;
}
function approximateUtcFromDayHour(day, hour=0, minute=0){
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  const today = now.getUTCDate();
  if (day - today > 20) month -= 1;
  if (today - day > 20) month += 1;
  const dt = new Date(Date.UTC(year, month, day, hour, minute));
  return dt.getTime();
}
function parseMetarText(raw, icao){
  if (!raw) return null;
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  const rawLine = lines[lines.length - 1].trim();
  const timeMatch = rawLine.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  let reportMs = Date.now();
  if (timeMatch){
    const [, dd, hh, mm] = timeMatch;
    reportMs = approximateUtcFromDayHour(Number(dd), Number(hh), Number(mm));
  }
  const tokens = rawLine.split(/\s+/);
  const visToken = extractVisibilityToken(tokens);
  const vvToken = tokens.find(t => /^VV\d{3}/.test(t));
  const clouds = tokens.filter(t => CLOUD_LAYER_TOKEN_RE.test(t)).map(parseCloudLayerToken).filter(Boolean);
  const visib = visToken ? parseVisibilityToSM(visToken, { icao }) : null;
  const vertVis = vvToken ? Number(vvToken.slice(2)) * 100 : null;
  return {
    icaoId: icao,
    name: `${icao} (text feed)`,
    reportTime: new Date(reportMs).toISOString(),
    obsTime: Math.floor(reportMs / 1000),
    wxString: rawLine,
    visib,
    visibRaw: visToken || null,
    vertVis,
    clouds,
    rawOb: rawLine
  };
}
function parseTafText(raw, icao){
  if (!raw) return null;
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  const tafLine = lines.find(l => l.trim().startsWith('TAF')) || lines.find(l => l.includes(icao)) || '';
  const rawTAF = lines.join(' ').replace(/\s+/g,' ').trim();
  if (!rawTAF) return null;
  const fcsts = parseTafRawForecasts(rawTAF, icao);
  return {
    icaoId: icao,
    name: `${icao} (text feed)`,
    rawTAF,
    fcsts
  };
}
function extractTafRawFromText(raw, icao){
  const cleaned = String(raw || '').trim();
  if (!cleaned) return '';
  if (/NO\s+DATA|NOT\s+AVAILABLE|NO\s+TAF|ERROR/i.test(cleaned)) return '';
  const lines = cleaned.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return '';
  const icaoToken = icao ? String(icao).toUpperCase() : '';
  const startIdx = lines.findIndex(line => {
    const upper = line.toUpperCase();
    return upper.startsWith('TAF') || (icaoToken && upper.includes(` ${icaoToken} `)) || upper.startsWith(icaoToken);
  });
  const selected = startIdx === -1 ? lines : lines.slice(startIdx);
  return selected.join(' ').replace(/\s+/g, ' ').trim();
}
function decodeTafFromTextResponse(raw, icao, sourceLabel){
  const rawTAF = extractTafRawFromText(raw, icao);
  if (!rawTAF) return null;
  return buildTafFromRaw(rawTAF, icao, sourceLabel) || parseTafText(rawTAF, icao);
}
function buildTafFromRaw(rawTAF, icao, sourceLabel){
  const cleaned = String(rawTAF || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  const fcsts = parseTafRawForecasts(cleaned, icao);
  if (!fcsts.length) return null;
  return {
    icaoId: icao,
    name: `${icao} (${sourceLabel})`,
    rawTAF: cleaned,
    fcsts
  };
}
function parseTafRawForecasts(rawTAF, icao){
  if (!rawTAF) return [];
  const tokens = rawTAF.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const validIdx = tokens.findIndex(t => /^\d{4}\/\d{4}$/.test(t));
  if (validIdx === -1) return [];
  const validToken = tokens[validIdx];
  const [fromToken, toToken] = validToken.split('/');
  const validFromMs = approximateUtcFromDayHour(Number(fromToken.slice(0,2)), Number(fromToken.slice(2)));
  const validToMs = approximateUtcFromDayHour(Number(toToken.slice(0,2)), Number(toToken.slice(2)));
  const baseSegments = [];
  const overlaySegments = [];
  let baseTokens = [];
  let baseStartMs = validFromMs;
  let baseIndicator = '';

  const isChangeToken = (token) => {
    if (/^FM\d{6}$/.test(token)) return true;
    if (token === 'TEMPO' || token === 'BECMG') return true;
    if (/^PROB(30|40)$/.test(token)) return true;
    return false;
  };
  const parseDayHourRange = (token) => {
    if (!/^\d{4}\/\d{4}$/.test(token)) return null;
    const [start, end] = token.split('/');
    return {
      startMs: approximateUtcFromDayHour(Number(start.slice(0,2)), Number(start.slice(2))),
      endMs: approximateUtcFromDayHour(Number(end.slice(0,2)), Number(end.slice(2)))
    };
  };
  const parseFmToken = (token) => {
    const match = token.match(/^FM(\d{2})(\d{2})(\d{2})$/);
    if (!match) return null;
    const [, dd, hh, mm] = match;
    return approximateUtcFromDayHour(Number(dd), Number(hh), Number(mm));
  };
  const buildSegment = (segmentTokens, startMs, endMs, changeIndicator, startIdx, endIdx) => {
    if (!startMs || !endMs || startMs === endMs) return null;
    const visToken = extractVisibilityToken(segmentTokens);
    const cloudTokens = segmentTokens.filter(t => CLOUD_LAYER_TOKEN_RE.test(t));
    const clouds = cloudTokens.map(parseCloudLayerToken).filter(Boolean);
    const windToken = segmentTokens.find(t => parseWindToken(t));
    const wind = windToken ? parseWindToken(windToken) : null;
    const wxString = segmentTokens.join(' ').trim();
    return {
      timeFrom: Math.floor(startMs / 1000),
      timeTo: Math.floor(endMs / 1000),
      visib: visToken ? parseVisibilityToSM(visToken, { icao }) : null,
      visibRaw: visToken || null,
      clouds,
      vertVis: null,
      wdir: wind?.dir ?? null,
      wspd: wind?.speed ?? null,
      wgust: wind?.gust ?? null,
      wxString,
      changeIndicator,
      cloudsExplicit: cloudTokens.length > 0,
      visibilityExplicit: Boolean(visToken),
      tokenRange: (Number.isInteger(startIdx) && Number.isInteger(endIdx) && endIdx > startIdx)
        ? { start: startIdx, end: endIdx }
        : null
    };
  };

  let i = validIdx + 1;
  let baseTokensStartIdx = i;
  while (i < tokens.length){
    const token = tokens[i];
    if (/^FM\d{6}$/.test(token)){
      const nextStartMs = parseFmToken(token);
      if (nextStartMs){
        const baseSeg = buildSegment(baseTokens, baseStartMs, nextStartMs, baseIndicator, baseTokensStartIdx, i);
        if (baseSeg) baseSegments.push(baseSeg);
        baseTokens = [];
        baseStartMs = nextStartMs;
        baseIndicator = 'FM';
        baseTokensStartIdx = i;
      }
      i += 1;
      continue;
    }
    if (token === 'BECMG'){
      const range = parseDayHourRange(tokens[i + 1] || '');
      if (range){
        const baseSeg = buildSegment(baseTokens, baseStartMs, range.startMs, baseIndicator, baseTokensStartIdx, i);
        if (baseSeg) baseSegments.push(baseSeg);
        const carriedTokens = baseTokens.length ? [...baseTokens] : [];
        const carriedStartIdx = Number.isInteger(baseTokensStartIdx) ? baseTokensStartIdx : i;
        baseTokens = carriedTokens;
        baseStartMs = range.startMs;
        baseIndicator = 'BECMG';
        baseTokensStartIdx = Math.min(carriedStartIdx, i);
        i += 2;
        continue;
      }
    }
    if (token === 'TEMPO' || /^PROB(30|40)$/.test(token)){
      let indicator = token;
      let j = i + 1;
      if (/^PROB(30|40)$/.test(token) && tokens[j] === 'TEMPO'){
        indicator = `${indicator} TEMPO`;
        j += 1;
      }
      const range = parseDayHourRange(tokens[j] || '');
      if (!range){
        i += 1;
        continue;
      }
      const segmentTokens = [];
      const segmentStartIdx = i;
      j += 1;
      while (j < tokens.length && !isChangeToken(tokens[j])){
        segmentTokens.push(tokens[j]);
        j += 1;
      }
      const overlaySeg = buildSegment(segmentTokens, range.startMs, range.endMs, indicator, segmentStartIdx, j);
      if (overlaySeg) overlaySegments.push(overlaySeg);
      i = j;
      continue;
    }
    baseTokens.push(token);
    i += 1;
  }
  const finalBase = buildSegment(baseTokens, baseStartMs, validToMs, baseIndicator, baseTokensStartIdx, tokens.length);
  if (finalBase) baseSegments.push(finalBase);
  const isProbOverlay = (seg) => /^PROB/.test(String(seg?.changeIndicator || '').toUpperCase());
  const findCarrierSegment = (seg) => {
    const overlayCarrier = overlaySegments.find(o =>
      o && o !== seg && !isProbOverlay(o) && seg.timeFrom < o.timeTo && seg.timeTo > o.timeFrom
    );
    if (overlayCarrier) return overlayCarrier;
    return baseSegments.find(b => seg.timeFrom < b.timeTo && seg.timeTo > b.timeFrom) || null;
  };
  const overlaysWithBase = overlaySegments.map(seg => {
    if (!seg) return null;
    const carrier = findCarrierSegment(seg);
    if (!carrier) return seg;
    const clouds = (Array.isArray(seg.clouds) && seg.clouds.length) ? seg.clouds : (carrier.clouds || []);
    const visib = seg.visib ?? carrier.visib ?? null;
    const visibRaw = seg.visibRaw ?? carrier.visibRaw ?? null;
    return {
      ...seg,
      visib,
      visibRaw,
      vertVis: seg.vertVis ?? carrier.vertVis ?? null,
      clouds,
      cloudsExplicit: Boolean(seg.cloudsExplicit),
      visibilityExplicit: Boolean(seg.visibilityExplicit),
      cloudsCarried: !seg.cloudsExplicit && clouds.length > 0,
      visibilityCarried: !seg.visibilityExplicit && (visib !== null || visibRaw !== null)
    };
  }).filter(Boolean);
  const fcsts = [...baseSegments, ...overlaysWithBase].filter(Boolean);
  fcsts.fmTimes = parseTafFmTimes(rawTAF);
  if (icao) fcsts.icaoId = icao;
  return fcsts;
}
function normalizeTafPayload(raw, icao){
  if (!raw) return null;
  const normalizeTimeToMs = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number'){
      return value > 1000000000000 ? value : value * 1000;
    }
    if (typeof value === 'string'){
      const trimmed = value.trim();
      if (!trimmed) return null;
      const asNumber = Number(trimmed);
      if (!Number.isNaN(asNumber)){
        return asNumber > 1000000000000 ? asNumber : asNumber * 1000;
      }
      const parsed = Date.parse(trimmed);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  };
  const fcstList = Array.isArray(raw.fcsts) ? raw.fcsts
    : Array.isArray(raw.forecast) ? raw.forecast
    : Array.isArray(raw.forecasts) ? raw.forecasts
    : Array.isArray(raw.data) ? raw.data
    : [];
  const fcsts = fcstList.map(f => {
    const timeFrom = f.timeFrom || f.fcst_time_from || f.valid_time_from || f.validTimeFrom || f.start_time || f.startTime;
    const timeTo = f.timeTo || f.fcst_time_to || f.valid_time_to || f.validTimeTo || f.end_time || f.endTime;
    const cloudsSrc = f.clouds || f.sky_condition || [];
    const changeIndicator = f.change_indicator || f.changeIndicator || f.change_type || f.changeType || f.type || f.fcst_type || '';
    const probability = f.probability || f.prob || f.probability_pct || f.probabilityPercent || null;
    const windDir = f.wdir || f.wind_dir_degrees || f.windDirDegrees || f.wind_dir || f.windDir;
    const windSpeed = f.wspd || f.wind_speed_kt || f.windSpeedKt || f.wind_speed_kts || f.windSpeedKts || f.wind_speed;
    const windGust = f.wgust || f.wgst || f.wind_gust_kt || f.windGustKt || f.wind_gust_kts || f.windGustKts || f.wind_gust;
    const clouds = (Array.isArray(cloudsSrc) ? cloudsSrc : [cloudsSrc]).filter(Boolean).map(c => ({
      cover: c.cover || c.sky_cover || c.skyCover || c.code || c.type || '',
      base: normalizeCloudBaseFt(c.base || c.cloud_base_ft_agl || c.base_ft_agl || c.altitude)
    }));
    const visRaw = f.visib || f.visibility || f.visibility_statute_mi || f.visibility_statute_mi || f.visibility_sm;
    const vertVis = f.vertVis || f.vert_vis_ft || f.vert_vis || f.vertical_visibility;
    const wx = f.wxString || f.wx_string || f.weather_string || f.raw_text || f.text || '';
    const fromMs = normalizeTimeToMs(timeFrom);
    const toMs = normalizeTimeToMs(timeTo);
    if (!fromMs || !toMs) return null;
    return {
      timeFrom: Math.floor(fromMs / 1000),
      timeTo: Math.floor(toMs / 1000),
      visib: parseVisibilityToSM(visRaw, { icao }),
      visibRaw: visRaw === null || visRaw === undefined ? null : String(visRaw).trim(),
      vertVis: vertVis ? normalizeCloudBaseFt(vertVis) : null,
      clouds,
      wdir: windDir ?? null,
      wspd: windSpeed ?? null,
      wgust: windGust ?? null,
      wxString: wx.trim(),
      changeIndicator: changeIndicator ? String(changeIndicator).trim() : '',
      probability: probability === null ? null : Number(probability)
    };
  }).filter(Boolean);
  const rawTAF = raw.rawTAF || raw.raw_text || raw.taf || '';
  const fmTimes = parseTafFmTimes(rawTAF);
  const sorted = fcsts.sort((a, b) => (a.timeFrom - b.timeFrom) || (a.timeTo - b.timeTo));
  sorted.fmTimes = fmTimes;
  if (icao) sorted.icaoId = icao;
  return sorted.length ? { icaoId: icao, name: raw.name || `${icao} (decoder)`, rawTAF, fcsts: sorted } : null;
}
function parseTafFmTimes(rawTAF){
  if (!rawTAF) return [];
  const tokens = String(rawTAF).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const times = tokens.map(token => {
    const match = token.match(/^FM(\d{2})(\d{2})(\d{2})$/);
    if (!match) return null;
    const [, dd, hh, mm] = match;
    const ms = approximateUtcFromDayHour(Number(dd), Number(hh), Number(mm));
    return Math.floor(ms / 1000);
  }).filter(Boolean);
  return Array.from(new Set(times)).sort((a, b) => a - b);
}
function majorityVote(items, keyFn){
  const counts = new Map();
  items.forEach((item, idx) => {
    const key = keyFn(item, idx);
    if (key === null || key === undefined) return;
    if (!counts.has(key)) counts.set(key, { count: 0, indexes: [] });
    const bucket = counts.get(key);
    bucket.count += 1;
    bucket.indexes.push(idx);
  });
  let winner = null;
  for (const entry of counts.values()){
    if (!winner || entry.count > winner.count) winner = entry;
  }
  if (!winner || winner.count < 2) return null;
  return winner;
}
function tafConsensusForTime(decodes, targetMs){
  const decoderAvailable = decodes.map(d => Boolean(d && !d.unavailable));
  const decoderUnknown = decodes.map(d => Boolean(d?.unavailable));
  const normalizeWxKey = (wx) => String(wx || '')
    .toUpperCase()
    .replace(/\bNSW\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalizeCeiling = (ceiling) => (
    ceiling === null || ceiling === undefined ? null : Math.round(ceiling / 100) * 100
  );
  const normalizeVis = (vis) => (
    vis === null || vis === undefined ? null : Math.round(vis * 2) / 2
  );
  const segmentsClose = (a, b) => {
    if (!a || !b) return false;
    const severityA = classifyFlightRules(a.ceiling, a.vis).code;
    const severityB = classifyFlightRules(b.ceiling, b.vis).code;
    if (severityA !== severityB) return false;
    const ceilingClose = a.ceiling === null || b.ceiling === null
      ? a.ceiling === b.ceiling
      : Math.abs(a.ceiling - b.ceiling) <= 300;
    const visClose = a.vis === null || b.vis === null
      ? a.vis === b.vis
      : Math.abs(a.vis - b.vis) <= 0.5;
    const wxA = normalizeWxKey(a.wxKey);
    const wxB = normalizeWxKey(b.wxKey);
    const wxClose = !wxA || !wxB || wxA === wxB;
    return ceilingClose && visClose && wxClose;
  };
  const selectWorstSegment = (entries) => {
    if (!entries.length) return null;
    return entries.reduce((worst, entry) => {
      if (!entry) return worst;
      if (!worst) return entry;
      const severity = classifyFlightRules(entry.ceiling, entry.vis).code;
      const worstSeverity = classifyFlightRules(worst.ceiling, worst.vis).code;
      const severityRank = { LIFR: 4, IFR: 3, MVFR: 2, VFR: 1, UNK: 0 };
      const score = severityRank[severity] ?? 0;
      const worstScore = severityRank[worstSeverity] ?? 0;
      if (score !== worstScore) return score > worstScore ? entry : worst;
      const ceilVal = entry.ceiling ?? Infinity;
      const worstCeilVal = worst.ceiling ?? Infinity;
      if (ceilVal !== worstCeilVal) return ceilVal < worstCeilVal ? entry : worst;
      const visVal = entry.vis ?? Infinity;
      const worstVisVal = worst.vis ?? Infinity;
      if (visVal !== worstVisVal) return visVal < worstVisVal ? entry : worst;
      return entry;
    }, null);
  };
  const segments = decodes.map((d, idx) => {
    if (!decoderAvailable[idx] || !d?.taf) return null;
    const seg = tafSegmentForTime(d.taf.fcsts, targetMs, { excludeProb: true });
    if (!seg) return null;
    const worst = tafWorstConditionsForTime(d.taf.fcsts, targetMs);
    const ceiling = worst.ceiling;
    const vis = worst.visibility;
    const wxKey = wxWithCarry(d.taf.fcsts, seg).toUpperCase().replace(/\s+/g,' ').trim();
    return {
      seg,
      fcsts: d.taf.fcsts,
      ceiling,
      vis,
      key: `${ceiling ?? 'X'}|${vis ?? 'X'}|${wxKey}`,
      normalizedKey: `${normalizeCeiling(ceiling) ?? 'X'}|${normalizeVis(vis) ?? 'X'}|${normalizeWxKey(wxKey) || 'NONE'}`,
      wxKey,
      probLabel: tafProbLabelForTime(d.taf.fcsts, targetMs)
    };
  });
  const anySegments = segments.some(Boolean);
  if (!anySegments) {
    return {
      segment: null,
      icons: decodes.map((d, idx) => (
        decoderUnknown[idx] ? 'unknown' : (decoderAvailable[idx] ? Boolean(d?.taf) : null)
      )),
      probLabel: '',
      fcsts: null,
      disagreement: false
    };
  }
  const availableSegments = segments.filter(Boolean);
  const disagreement = availableSegments.length >= 2
    && !availableSegments.every(seg => segmentsClose(seg, availableSegments[0]));
  const vote = majorityVote(segments, s => s?.normalizedKey ?? s?.key);
  const icons = segments.map((s, idx) => (
    decoderUnknown[idx] ? 'unknown' : (decoderAvailable[idx] ? Boolean(s) : null)
  ));
  if (vote){
    const chosenIdx = vote.indexes[0];
    const chosenEntry = chosenIdx >= 0 ? segments[chosenIdx] : null;
    return {
      segment: chosenEntry?.seg || null,
      icons: segments.map((s, idx) => (
        decoderUnknown[idx]
          ? 'unknown'
          : (decoderAvailable[idx] ? (s && chosenEntry ? segmentsClose(s, chosenEntry) : false) : null)
      )),
      probLabel: chosenIdx >= 0 ? (segments[chosenIdx]?.probLabel || '') : '',
      fcsts: chosenEntry?.fcsts || null,
      disagreement
    };
  }
  const available = segments.filter(Boolean);
  const chosen = selectWorstSegment(available);
  if (!chosen) return { segment: null, icons, probLabel: '', fcsts: null, disagreement };
  const fallbackIcons = segments.map((s, idx) => (
    decoderUnknown[idx]
      ? 'unknown'
      : (decoderAvailable[idx] ? (s ? segmentsClose(s, chosen) : false) : null)
  ));
  const chosenProb = segments.find(s => s?.seg === chosen.seg)?.probLabel || '';
  return {
    segment: chosen.seg,
    icons: fallbackIcons,
    probLabel: chosenProb,
    fcsts: chosen.fcsts || null,
    disagreement
  };
}
function renderDecoderIcons(flags){
  if (!Array.isArray(flags)) return '';
  return `<div class="decoder-row">${flags.map(ok => {
    if (ok === 'unknown') return `<span class="decoder-unknown">?</span>`;
    if (ok === null) return `<span class="decoder-na">—</span>`;
    return `<span class="${ok ? 'decoder-ok' : 'decoder-bad'}">${ok ? '✔' : '✖'}</span>`;
  }).join('')}</div>`;
}
async function loadAirportLookup(){
  if (airportLookupPromise) return airportLookupPromise;
  airportLookupPromise = fetchJsonWithCorsFallback(IATA_LOOKUP_URL, 'force-cache')
    .then(list => {
      const map = { ...IATA_FALLBACK_MAP };
      (list || []).forEach(entry => {
        const ia = entry?.iata_code, ic = entry?.icao_code;
        if (ia && ic) map[String(ia).toUpperCase()] = String(ic).toUpperCase();
      });
      return map;
    }).catch(err => {
      console.warn('IATA directory fetch failed; using fallback map only.', err);
      return { ...IATA_FALLBACK_MAP };
    });
  return airportLookupPromise;
}
async function loadAirportTimezones(){
  if (airportTimezonePromise) return airportTimezonePromise;
  airportTimezonePromise = fetchJsonWithCorsFallback(AIRPORT_TZ_LOOKUP_URL, 'force-cache')
    .then(list => {
      const map = { ...AIRPORT_TZ_FALLBACK };
      if (list && typeof list === 'object'){
        Object.values(list).forEach(entry => {
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
    .catch(err => {
      console.warn('Airport timezone fetch failed; using fallback map only.', err);
      airportTimezoneCache = { ...AIRPORT_TZ_FALLBACK };
      return { ...airportTimezoneCache };
    });
  return airportTimezonePromise;
}
async function resolveAirportTimeZone(input, contextLabel = 'layover'){
  const code = String(input || '').trim().toUpperCase();
  if (!code) throw new Error(`Enter a ${contextLabel} airport code.`);
  if (code.length !== 3 && code.length !== 4){
    throw new Error(`Use a 3-letter IATA or 4-letter ICAO code for the ${contextLabel} airport.`);
  }
  const lookup = await loadAirportTimezones();
  if (lookup[code]) return lookup[code];
  if (code.length === 3 && lookup[`C${code}`]) return lookup[`C${code}`];
  throw new Error(`Unable to find a time zone for ${code}.`);
}
function getTimeZoneOffsetMinutes(timeZone, date){
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
async function computeTimezoneDiffFromYYZ(input){
  const layoverZone = await resolveAirportTimeZone(input, 'layover');
  const now = new Date();
  const yyzOffset = getTimeZoneOffsetMinutes('America/Toronto', now);
  const layoverOffset = getTimeZoneOffsetMinutes(layoverZone, now);
  const diffHours = Math.abs((layoverOffset - yyzOffset) / 60);
  return Math.round(diffHours * 100) / 100;
}

async function computeTimezoneDiffBetweenAirports(departureInput, arrivalInput){
  const [departureZone, arrivalZone] = await Promise.all([
    resolveAirportTimeZone(departureInput, 'departure'),
    resolveAirportTimeZone(arrivalInput, 'arrival')
  ]);
  const now = new Date();
  const departureOffset = getTimeZoneOffsetMinutes(departureZone, now);
  const arrivalOffset = getTimeZoneOffsetMinutes(arrivalZone, now);
  const diffHours = Math.abs((arrivalOffset - departureOffset) / 60);
  return Math.round(diffHours * 100) / 100;
}

async function computeFdpStartInYYZ(startTime, departureCode){
  const startMinutes = parseTimeToMinutes(startTime);
  if (!Number.isFinite(startMinutes)) throw new Error('Enter an FDP start time in HH:MM.');
  const departure = normalizeAirportCode(departureCode);
  if (!departure) throw new Error('Enter a departure airport code.');
  const departureZone = await resolveAirportTimeZone(departure, 'departure');
  const now = new Date();
  const yyzOffset = getTimeZoneOffsetMinutes('America/Toronto', now);
  const departureOffset = getTimeZoneOffsetMinutes(departureZone, now);
  const diffMinutes = Math.round(yyzOffset - departureOffset);
  const yyzMinutes = ((startMinutes + diffMinutes) % 1440 + 1440) % 1440;
  const startUtcMinutes = startMinutes - departureOffset;
  return {
    startMinutes: yyzMinutes,
    startUtcMinutes,
    departure,
    localLabel: formatMinutesToTime(startMinutes),
    yyzLabel: formatMinutesToTime(yyzMinutes)
  };
}

function attachTimeConverter({ airportId, localId, utcId, noteId }){
  const airportEl = document.getElementById(airportId);
  const localEl = document.getElementById(localId);
  const utcEl = document.getElementById(utcId);
  const noteEl = noteId ? document.getElementById(noteId) : null;
  if (!airportEl || !localEl || !utcEl) return;
  const defaultNote = noteEl?.textContent || '';
  let lastEdited = 'local';
  let isUpdating = false;

  const resetNote = () => {
    if (noteEl) noteEl.textContent = defaultNote;
  };

  const setError = (err) => {
    if (noteEl) noteEl.textContent = err?.message || 'Unable to convert time.';
  };

  const updateUtcFromLocal = async () => {
    if (isUpdating) return;
    isUpdating = true;
    try {
      const localMinutes = parseTimeToMinutes(localEl.value);
      if (!Number.isFinite(localMinutes)){
        utcEl.value = '';
        resetNote();
        return;
      }
      const tz = await resolveAirportTimeZone(airportEl.value, 'local');
      const offsetMinutes = getTimeZoneOffsetMinutes(tz, new Date());
      const utcMinutes = localMinutes - offsetMinutes;
      utcEl.value = formatMinutesToTime(utcMinutes);
      resetNote();
    } catch (err) {
      utcEl.value = '';
      setError(err);
    } finally {
      isUpdating = false;
    }
  };

  const updateLocalFromUtc = async () => {
    if (isUpdating) return;
    isUpdating = true;
    try {
      const utcMinutes = parseTimeToMinutes(utcEl.value);
      if (!Number.isFinite(utcMinutes)){
        localEl.value = '';
        resetNote();
        return;
      }
      const tz = await resolveAirportTimeZone(airportEl.value, 'local');
      const offsetMinutes = getTimeZoneOffsetMinutes(tz, new Date());
      const localMinutes = utcMinutes + offsetMinutes;
      localEl.value = formatMinutesToTime(localMinutes);
      resetNote();
    } catch (err) {
      localEl.value = '';
      setError(err);
    } finally {
      isUpdating = false;
    }
  };

  localEl.addEventListener('input', () => {
    lastEdited = 'local';
    updateUtcFromLocal();
  });
  utcEl.addEventListener('input', () => {
    lastEdited = 'utc';
    updateLocalFromUtc();
  });
  airportEl.addEventListener('input', () => {
    if (lastEdited === 'utc') {
      updateLocalFromUtc();
    } else {
      updateUtcFromLocal();
    }
  });
}

function attachAirportToAirportConverter({ fromAirportId, toAirportId, fromTimeId, toTimeId, noteId }){
  const fromAirportEl = document.getElementById(fromAirportId);
  const toAirportEl = document.getElementById(toAirportId);
  const fromTimeEl = document.getElementById(fromTimeId);
  const toTimeEl = document.getElementById(toTimeId);
  const noteEl = noteId ? document.getElementById(noteId) : null;
  if (!fromAirportEl || !toAirportEl || !fromTimeEl || !toTimeEl) return;
  const defaultNote = noteEl?.textContent || '';
  let lastEdited = 'from';
  let isUpdating = false;

  const resetNote = () => {
    if (noteEl) noteEl.textContent = defaultNote;
  };

  const setError = (err) => {
    if (noteEl) noteEl.textContent = err?.message || 'Unable to convert time.';
  };

  const updateOpposite = async (source) => {
    if (isUpdating) return;
    isUpdating = true;
    try {
      const sourceTimeEl = source === 'from' ? fromTimeEl : toTimeEl;
      const targetTimeEl = source === 'from' ? toTimeEl : fromTimeEl;
      const sourceAirportEl = source === 'from' ? fromAirportEl : toAirportEl;
      const targetAirportEl = source === 'from' ? toAirportEl : fromAirportEl;

      const sourceMinutes = parseTimeToMinutes(sourceTimeEl.value);
      if (!Number.isFinite(sourceMinutes)){
        targetTimeEl.value = '';
        resetNote();
        return;
      }

      const [sourceTz, targetTz] = await Promise.all([
        resolveAirportTimeZone(sourceAirportEl.value, 'from'),
        resolveAirportTimeZone(targetAirportEl.value, 'to')
      ]);
      const now = new Date();
      const sourceOffset = getTimeZoneOffsetMinutes(sourceTz, now);
      const targetOffset = getTimeZoneOffsetMinutes(targetTz, now);
      const utcMinutes = sourceMinutes - sourceOffset;
      const targetMinutes = utcMinutes + targetOffset;
      targetTimeEl.value = formatMinutesToTime(targetMinutes);
      resetNote();
    } catch (err) {
      const targetTimeEl = source === 'from' ? toTimeEl : fromTimeEl;
      targetTimeEl.value = '';
      setError(err);
    } finally {
      isUpdating = false;
    }
  };

  const reapply = () => updateOpposite(lastEdited);

  fromTimeEl.addEventListener('input', () => {
    lastEdited = 'from';
    updateOpposite('from');
  });
  toTimeEl.addEventListener('input', () => {
    lastEdited = 'to';
    updateOpposite('to');
  });
  fromAirportEl.addEventListener('input', reapply);
  toAirportEl.addEventListener('input', reapply);
}

function initTimeConverterModeSwitch({ selectId, utcGroupId, otherGroupId, noteId }){
  const selectEl = document.getElementById(selectId);
  const utcGroup = document.getElementById(utcGroupId);
  const otherGroup = document.getElementById(otherGroupId);
  const noteEl = noteId ? document.getElementById(noteId) : null;
  const defaultNote = noteEl?.textContent || '';
  if (!selectEl || !utcGroup || !otherGroup) return;
  const apply = () => {
    const mode = selectEl.value === 'other' ? 'other' : 'utc';
    utcGroup.classList.toggle('hidden', mode !== 'utc');
    otherGroup.classList.toggle('hidden', mode !== 'other');
    if (noteEl) noteEl.textContent = defaultNote;
  };
  selectEl.addEventListener('change', apply);
  apply();
}

function formatDayOffsetLabel(dayOffset){
  if (!Number.isFinite(dayOffset) || dayOffset === 0) return 'Same day';
  const abs = Math.abs(dayOffset);
  const suffix = abs === 1 ? 'day' : 'days';
  return `${dayOffset > 0 ? '+' : '-'}${abs} ${suffix}`;
}

function sendTimeCalcToConverter({ timeLabel, dayOffset, isModern }){
  if (!timeLabel) return;
  if (isModern){
    setModernPrimaryTab('modern-duty-rest');
    setModernDutyTab('modern-time-converter');
  } else {
    setLegacyPrimaryTab('duty-rest');
    setLegacyDutyTab('time-converter');
  }
  const localId = isModern ? 'modern-time-local' : 'time-local';
  const noteId = isModern ? 'modern-time-note' : 'time-note';
  const localEl = document.getElementById(localId);
  const noteEl = noteId ? document.getElementById(noteId) : null;
  if (localEl){
    localEl.value = timeLabel;
    localEl.dispatchEvent(new Event('input', { bubbles: true }));
    localEl.focus();
  }
  if (noteEl){
    const suffix = dayOffset === 0 ? '' : ` (${formatDayOffsetLabel(dayOffset)})`;
    const msg = `From time calculator${suffix}`;
    setTimeout(() => { noteEl.textContent = msg; }, 0);
  }
}

function runTimeCalculator({ startId, hoursId, minutesId, modeId, outId, converterTarget }){
  const out = document.getElementById(outId);
  const startEl = document.getElementById(startId);
  const hoursEl = document.getElementById(hoursId);
  const minutesEl = document.getElementById(minutesId);
  const modeEl = document.getElementById(modeId);
  if (!out || !startEl || !hoursEl || !minutesEl || !modeEl) return;
  const showError = (msg) => {
    out.innerHTML = `<div class="simple"><div class="block"><div class="label">Error</div><div class="value">${msg}</div></div></div>`;
  };
  try {
    const startMinutes = parseTimeToMinutes(startEl.value);
    if (!Number.isFinite(startMinutes)) throw new Error('Enter a start time in HH:MM.');
    const hours = Number(hoursEl.value);
    if (!Number.isFinite(hours) || hours < 0) throw new Error('Hours must be zero or more.');
    const minutes = Number(minutesEl.value);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 60) throw new Error('Minutes must be between 0 and 59.');
    const deltaMinutes = Math.round((hours * 60) + minutes);
    const mode = modeEl.value === 'subtract' ? -1 : 1;
    const adjusted = startMinutes + (deltaMinutes * mode);
    const dayOffset = Math.floor(adjusted / 1440);
    const adjustedLabel = formatMinutesToTime(adjusted);
    const canConvert = Boolean(converterTarget);
    out.innerHTML = `
      <div class="simple">
        <div class="block">
          <div class="label">Adjusted time</div>
          <div class="value">${adjustedLabel}</div>
        </div>
        <div class="block">
          <div class="label">Day offset</div>
          <div class="value">${formatDayOffsetLabel(dayOffset)}</div>
        </div>
      </div>
      ${canConvert ? `<button class="convert-btn" type="button" data-action="timecalc-convert" aria-label="Send ${adjustedLabel} (${formatDayOffsetLabel(dayOffset)}) to time converter">Convert</button>` : ''}
    `;
    if (canConvert){
      const convertBtn = out.querySelector('[data-action="timecalc-convert"]');
      if (convertBtn){
        addTapListener(convertBtn, (e) => {
          hapticTap(e.currentTarget);
          sendTimeCalcToConverter({
            timeLabel: adjustedLabel,
            dayOffset,
            isModern: converterTarget === 'modern'
          });
        });
      }
    }
  } catch (err){
    showError(err?.message || 'Unable to calculate time.');
  }
}
async function resolveAirportCode(input){
  const code = String(input || '').trim().toUpperCase();
  if (!code) throw new Error('Enter an airport code.');
  if (code.length === 4) return code;
  if (code.length === 3){
    const lookup = await loadAirportLookup();
    if (lookup[code]) return lookup[code];
    if (code.startsWith('Y')) return `C${code}`; // common Canadian pattern when lookup unavailable
    throw new Error(`Unable to map ${code} to an ICAO station.`);
  }
  throw new Error('Use a 3-letter IATA or 4-letter ICAO code.');
}
const FT_VISIBILITY_PREFIXES = ['MU']; // Cuban stations publish visibility in feet (e.g., MUCC 9000)

function shouldTreatVisibilityAsFeet(raw, icao){
  const code = typeof icao === 'string' ? icao.trim().toUpperCase() : '';
  if (!code) return false;
  if (!FT_VISIBILITY_PREFIXES.some(prefix => code.startsWith(prefix))) return false;
  const token = String(raw ?? '').trim().toUpperCase();
  return /^\d{4}$/.test(token);
}

function parseVisibilityToSM(raw, options = {}){
  const { icao } = options;
  if (raw === null || raw === undefined) return null;
  const rawToken = String(raw).trim();
  if (!rawToken) return null;
  let s = rawToken.toUpperCase();
  s = s.replace(/SM/g,'').replace(/^P/,'').replace('+','').trim();
  const frac = s.match(/^(\d+)\s+(\d+)\/(\d+)$/) || s.match(/^(\d+)\/(\d+)$/);
  let num = null;
  if (frac){
    const whole = frac[3] ? Number(frac[1]) : 0;
    const top = Number(frac[frac.length === 4 ? 2 : 1]);
    const bot = Number(frac[frac.length === 4 ? 3 : 2]);
    if (bot > 0) num = whole + (top / bot);
  }
  if (num === null){
    const parsed = parseFloat(s);
    if (!Number.isNaN(parsed)) num = parsed;
  }
  if (num === null) return null;
  const treatAsFeet = shouldTreatVisibilityAsFeet(rawToken, icao);
  if (treatAsFeet) return +(num / 5280).toFixed(2);
  if (num > 50) return +(num / 1609.34).toFixed(2); // assume meters/visibility 9999 etc
  return +num.toFixed(2);
}
function normalizeCloudBaseFt(base){
  const b = Number(base);
  if (Number.isNaN(b)) return null;
  if (b < 250) return Math.round(b * 100);
  return Math.round(b);
}
function formatVisSm(v){
  if (v === null || v === undefined || Number.isNaN(v)) return 'Not reported';
  const toFraction = (val) => {
    const rounded = Math.round(val * 16) / 16;
    if (Math.abs(rounded - val) > 0.02) return null;
    const whole = Math.floor(rounded);
    const remainder = +(rounded - whole).toFixed(4);
    const numerator = Math.round(remainder * 16);
    const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
    if (numerator === 0) return `${whole}`;
    const divisor = gcd(numerator, 16);
    const num = numerator / divisor;
    const den = 16 / divisor;
    const frac = `${num}/${den}`;
    return whole ? `${whole} ${frac}` : frac;
  };
  if (v >= 10) return `${v.toFixed(1)} SM`;
  const frac = toFraction(v);
  if (frac) return `${frac} SM`;
  return v >= 1 ? `${v.toFixed(1)} SM` : `${v.toFixed(2)} SM`;
}
function formatVisibilityDisplay(valueSm, rawToken, options = {}){
  const { icao } = options;
  const cleaned = rawToken === null || rawToken === undefined ? '' : String(rawToken).trim();
  const treatAsFeet = shouldTreatVisibilityAsFeet(rawToken, icao);
  if (cleaned){
    const upper = cleaned.toUpperCase();
    if (upper === 'CAVOK') return 'CAVOK';
    if (/^P6SM$/.test(upper)) return '6+ SM';
    if (/SM$/.test(upper)){
      const base = cleaned.replace(/\s*SM$/i, '').trim();
      return `${base} SM`;
    }
    if (/^\d{4}$/.test(upper)){
      if (treatAsFeet && valueSm !== null && valueSm !== undefined){
        return `${cleaned} ft (${formatVisSm(valueSm)})`;
      }
      return `${cleaned} m`;
    }
    return cleaned;
  }
  return formatVisSm(valueSm);
}
function extractCeilingFt(clouds, vertVis){
  let ceil = null;
  if (Array.isArray(clouds)){
    clouds.forEach(c => {
      const cover = String(c?.cover || '').toUpperCase();
      if (['BKN','OVC','VV'].includes(cover)){
        const base = Number(c.base);
        if (!Number.isNaN(base)){
          if (ceil === null || base < ceil) ceil = base;
        }
      }
    });
  }
  if (vertVis !== undefined && vertVis !== null){
    const vv = Number(vertVis);
    if (!Number.isNaN(vv)){
      ceil = ceil === null ? vv : Math.min(ceil, vv);
    }
  }
  return ceil;
}
function hasSkyClear(segment){
  const clouds = segment?.clouds;
  if (Array.isArray(clouds)){
    if (clouds.some(c => String(c?.cover || '').toUpperCase() === 'SKC')) return true;
  }
  const raw = segment?.rawOb || segment?.raw_text || segment?.rawTAF || segment?.raw || '';
  return /\bSKC\b/.test(String(raw).toUpperCase());
}
function hasNoCeiling(segment){
  const clouds = segment?.clouds;
  if (Array.isArray(clouds) && clouds.length){
    const covers = clouds.map(c => String(c?.cover || '').toUpperCase());
    const hasCeilingLayer = covers.some(c => ['BKN','OVC','VV'].includes(c));
    if (!hasCeilingLayer) return true;
  }
  const raw = segment?.rawOb || segment?.raw_text || segment?.rawTAF || segment?.raw || '';
  return /\b(NSC|NCD|CLR)\b/.test(String(raw).toUpperCase());
}
function tafOrderedFcsts(fcsts){
  const ordered = [...fcsts].filter(Boolean).sort((a, b) => (a.timeFrom - b.timeFrom) || (a.timeTo - b.timeTo));
  if (Array.isArray(fcsts?.fmTimes)) ordered.fmTimes = fcsts.fmTimes;
  return ordered;
}
function tafFromCutoffTime(ordered, targetMs){
  if (!Array.isArray(ordered) || !ordered.length) return null;
  let cutoff = null;
  const fmTimes = Array.isArray(ordered.fmTimes) ? ordered.fmTimes : [];
  fmTimes.forEach(timeFrom => {
    if (!Number.isFinite(timeFrom) || timeFrom * 1000 > targetMs) return;
    if (cutoff === null || timeFrom > cutoff) cutoff = timeFrom;
  });
  ordered.forEach(seg => {
    const segFrom = Number(seg?.timeFrom);
    if (!Number.isFinite(segFrom) || segFrom * 1000 > targetMs) return;
    const change = String(seg?.changeIndicator || '').toUpperCase();
    const isFrom = change.startsWith('FM') || change.includes('FROM');
    if (!isFrom) return;
    if (cutoff === null || segFrom > cutoff) cutoff = segFrom;
  });
  return cutoff;
}
function tafScopedFcsts(ordered, targetMs){
  const cutoff = tafFromCutoffTime(ordered, targetMs);
  if (!Number.isFinite(cutoff)) return ordered;
  return ordered.filter(seg => Number.isFinite(seg?.timeFrom) && seg.timeFrom >= cutoff);
}
function ceilingWithCarry(fcsts, seg, { allowCarry = true } = {}){
  const direct = extractCeilingFt(seg?.clouds, seg?.vertVis);
  if (direct !== null && direct !== undefined) return direct;
  if (!allowCarry) return null;
  if (!Array.isArray(fcsts) || !seg) return null;
  const segFrom = Number(seg.timeFrom);
  if (!Number.isFinite(segFrom)) return null;
  const ordered = tafScopedFcsts(tafOrderedFcsts(fcsts), segFrom * 1000);
  const prior = ordered.filter(s => Number.isFinite(s.timeFrom) && s.timeFrom <= segFrom).sort((a, b) => b.timeFrom - a.timeFrom);
  for (const candidate of prior){
    const ceiling = extractCeilingFt(candidate.clouds, candidate.vertVis);
    if (ceiling !== null && ceiling !== undefined) return ceiling;
  }
  return null;
}
function visibilityWithCarryFromOrdered(ordered, seg, { allowCarry = true } = {}){
  const direct = parseVisibilityToSM(seg?.visib);
  if (direct !== null && direct !== undefined) return direct;
  if (!allowCarry) return null;
  if (!Array.isArray(ordered) || !seg) return null;
  const segFrom = Number(seg.timeFrom);
  if (!Number.isFinite(segFrom)) return null;
  const prior = ordered.filter(s => Number.isFinite(s.timeFrom) && s.timeFrom <= segFrom).sort((a, b) => b.timeFrom - a.timeFrom);
  for (const candidate of prior){
    const vis = parseVisibilityToSM(candidate.visib);
    if (vis !== null && vis !== undefined) return vis;
  }
  return null;
}
function visibilityWithCarry(fcsts, seg, opts = {}){
  if (!seg) return null;
  const segFrom = Number(seg.timeFrom);
  if (!Number.isFinite(segFrom)) return parseVisibilityToSM(seg?.visib);
  const ordered = tafScopedFcsts(tafOrderedFcsts(fcsts), segFrom * 1000);
  return visibilityWithCarryFromOrdered(ordered, seg, opts);
}
function visibilityRawWithCarryFromOrdered(ordered, seg, { allowCarry = true } = {}){
  const direct = segmentVisibilityRaw(seg);
  if (direct) return direct;
  if (!allowCarry) return null;
  if (!Array.isArray(ordered) || !seg) return null;
  const segFrom = Number(seg.timeFrom);
  if (!Number.isFinite(segFrom)) return null;
  const prior = ordered.filter(s => Number.isFinite(s.timeFrom) && s.timeFrom <= segFrom).sort((a, b) => b.timeFrom - a.timeFrom);
  for (const candidate of prior){
    const vis = segmentVisibilityRaw(candidate);
    if (vis) return vis;
  }
  return null;
}
function visibilityRawWithCarry(fcsts, seg, opts = {}){
  if (!seg) return null;
  const segFrom = Number(seg.timeFrom);
  if (!Number.isFinite(segFrom)) return segmentVisibilityRaw(seg);
  const ordered = tafScopedFcsts(tafOrderedFcsts(fcsts), segFrom * 1000);
  return visibilityRawWithCarryFromOrdered(ordered, seg, opts);
}
function wxWithCarry(fcsts, seg){
  const direct = (seg?.wxString || (Array.isArray(seg?.weather) ? seg.weather.join(' ') : '')).trim();
  if (direct) return direct;
  if (!Array.isArray(fcsts) || !seg) return '';
  const segFrom = Number(seg.timeFrom);
  if (!Number.isFinite(segFrom)) return '';
  const ordered = tafScopedFcsts(tafOrderedFcsts(fcsts), segFrom * 1000);
  const prior = ordered.filter(s => Number.isFinite(s.timeFrom) && s.timeFrom <= segFrom).sort((a, b) => b.timeFrom - a.timeFrom);
  for (const candidate of prior){
    const wx = (candidate?.wxString || (Array.isArray(candidate?.weather) ? candidate.weather.join(' ') : '')).trim();
    if (wx) return wx;
  }
  return '';
}
const WX_PRECIP_CODES = ['DZ', 'RA', 'SN', 'SG', 'IC', 'PL', 'GR', 'GS', 'UP'];
const WX_OBSTRUCTION_CODES = ['BR', 'FG', 'FU', 'VA', 'DU', 'SA', 'HZ', 'PY', 'PO', 'SQ', 'FC', 'SS', 'DS'];
const WX_DESCRIPTORS = ['TS', 'SH', 'FZ', 'BL', 'DR', 'MI', 'PR', 'BC'];
const WX_PHENOMENA_SEVERITY = {
  FC: 6,
  FG: 5,
  SS: 4,
  DS: 4,
  SN: 4,
  GR: 4,
  TS: 4,
  GS: 3,
  RA: 3,
  IC: 3,
  PL: 3,
  UP: 3,
  DZ: 2,
  SG: 2,
  BR: 2,
  FU: 2,
  VA: 2,
  PO: 2,
  SQ: 2,
  HZ: 1,
  DU: 1,
  SA: 1,
  PY: 1
};
function stripVisibilityFromWxText(wxRaw){
  if (!wxRaw) return '';
  const tokens = String(wxRaw).trim().split(/\s+/);
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1){
    const tok = tokens[i];
    if (!tok) continue;
    const upper = tok.toUpperCase();
    if (upper === 'RMK') break;
    const next = tokens[i + 1];
    if (/^\d+$/.test(tok) && next && /^M?\d+\/\d+SM$/i.test(next)){
      i += 1;
      continue;
    }
    if (/^(P|M)?\d+(\.\d+)?SM$/i.test(tok) || /^M?\d+\/\d+SM$/i.test(tok) || /^\d{4}$/.test(tok) || /^CAVOK$/i.test(tok)){
      continue;
    }
    kept.push(tok);
  }
  return kept.join(' ').trim();
}
function extractWeatherTokens(wxRaw){
  if (!wxRaw) return [];
  const tokens = String(wxRaw).trim().split(/\s+/);
  const seen = new Map();
  tokens.some((tok) => {
    if (String(tok || '').toUpperCase() === 'RMK') return true;
    return false;
  });
  for (let i = 0; i < tokens.length; i += 1){
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.toUpperCase() === 'RMK') break;
    const severity = wxTokenSeverity(tok);
    if (severity === null) continue;
    const key = tok.toUpperCase();
    const existing = seen.get(key);
    if (!existing || severity > existing.severity){
      seen.set(key, { token: tok, severity });
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => {
      if (b.severity !== a.severity) return b.severity - a.severity;
      return a.token.localeCompare(b.token);
    })
    .map(entry => entry.token);
}
function parseWindToken(token){
  if (!token) return null;
  const match = String(token).toUpperCase().match(/^(VRB|\d{3})(\d{2,3})(G(\d{2,3}))?(KT|MPS|KMH)$/);
  if (!match) return null;
  const [, dirRaw, speedRaw, , gustRaw, unitRaw] = match;
  let speed = Number(speedRaw);
  let gust = gustRaw ? Number(gustRaw) : null;
  if (!Number.isFinite(speed)) return null;
  let unit = unitRaw;
  if (unit === 'MPS'){
    speed *= 1.94384;
    if (Number.isFinite(gust)) gust *= 1.94384;
    unit = 'KT';
  } else if (unit === 'KMH'){
    speed *= 0.539957;
    if (Number.isFinite(gust)) gust *= 0.539957;
    unit = 'KT';
  }
  return {
    dir: dirRaw === 'VRB' ? 'VRB' : Number(dirRaw),
    speed: Math.round(speed),
    gust: Number.isFinite(gust) ? Math.round(gust) : null,
    unit
  };
}
function parseWindFromString(text){
  if (!text) return null;
  const tokens = String(text).trim().split(/\s+/);
  for (const token of tokens){
    const wind = parseWindToken(token);
    if (wind) return wind;
  }
  return null;
}
function parseWindNumbers(dir, speed, gust){
  const speedVal = Number(speed);
  if (!Number.isFinite(speedVal)) return null;
  const gustVal = Number(gust);
  const dirVal = Number(dir);
  const dirOut = Number.isFinite(dirVal)
    ? dirVal
    : (typeof dir === 'string' && dir.toUpperCase() === 'VRB' ? 'VRB' : null);
  return {
    dir: dirOut,
    speed: Math.round(speedVal),
    gust: Number.isFinite(gustVal) ? Math.round(gustVal) : null,
    unit: 'KT'
  };
}
function extractWindFromSegment(segment){
  if (!segment) return null;
  const wind = parseWindNumbers(
    segment.wdir ?? segment.wind_dir_degrees ?? segment.windDirDegrees ?? segment.wind_dir,
    segment.wspd ?? segment.wind_speed_kt ?? segment.windSpeedKt ?? segment.wind_speed_kts ?? segment.windSpeedKts ?? segment.wind_speed,
    segment.wgust ?? segment.wgst ?? segment.wind_gust_kt ?? segment.windGustKt ?? segment.wind_gust_kts ?? segment.windGustKts ?? segment.wind_gust
  );
  if (wind) return wind;
  const raw = segment.wxString || segment.rawOb || segment.raw_text || segment.rawTAF || segment.text || '';
  return parseWindFromString(raw);
}
function windWithCarry(fcsts, seg){
  const direct = extractWindFromSegment(seg);
  if (direct) return direct;
  if (!Array.isArray(fcsts) || !seg) return null;
  const segFrom = Number(seg.timeFrom);
  if (!Number.isFinite(segFrom)) return null;
  const ordered = tafScopedFcsts(tafOrderedFcsts(fcsts), segFrom * 1000);
  const prior = ordered.filter(s => Number.isFinite(s.timeFrom) && s.timeFrom <= segFrom).sort((a, b) => b.timeFrom - a.timeFrom);
  for (const candidate of prior){
    const wind = extractWindFromSegment(candidate);
    if (wind) return wind;
  }
  return null;
}
function compareWindSeverity(a, b){
  if (!a) return b;
  if (!b) return a;
  const aGust = a.gust ?? a.speed ?? 0;
  const bGust = b.gust ?? b.speed ?? 0;
  if (aGust !== bGust) return aGust > bGust ? a : b;
  const aSpeed = a.speed ?? 0;
  const bSpeed = b.speed ?? 0;
  if (aSpeed !== bSpeed) return aSpeed > bSpeed ? a : b;
  return a;
}
function formatWind(wind){
  if (!wind) return 'No wind reported';
  const speed = Number(wind.speed);
  if (!Number.isFinite(speed)) return 'No wind reported';
  if (speed === 0) return 'Calm';
  const dir = wind.dir === 'VRB'
    ? 'VRB'
    : (Number.isFinite(Number(wind.dir)) ? String(Math.round(Number(wind.dir))).padStart(3, '0') + '°' : '---');
  const gust = Number.isFinite(Number(wind.gust)) && Number(wind.gust) > 0 ? `G${Math.round(Number(wind.gust))}` : '';
  return `${dir} ${Math.round(speed)}${gust ? gust : ''} kt`;
}
function wxTokenSeverity(token){
  if (!token) return null;
  const upper = String(token).toUpperCase();
  if (upper === 'NSW') return null;
  const intensity = upper.startsWith('+') ? 1 : (upper.startsWith('-') ? -0.3 : 0);
  let cleaned = upper.replace(/^(\+|-)/, '');
  const vicinity = cleaned.startsWith('VC');
  cleaned = cleaned.replace(/^VC/, '');
  let descriptorScore = 0;
  if (cleaned.includes('TS')) descriptorScore += 1;
  if (cleaned.includes('FZ')) descriptorScore += 0.5;
  if (cleaned.includes('SH')) descriptorScore += 0.3;
  if (cleaned.includes('BL')) descriptorScore += 0.2;
  if (cleaned.includes('DR')) descriptorScore += 0.1;
  if (cleaned.includes('MI')) descriptorScore += 0.1;
  if (cleaned.includes('PR')) descriptorScore += 0.1;
  if (cleaned.includes('BC')) descriptorScore += 0.1;
  let base = null;
  const allCodes = WX_PRECIP_CODES.concat(WX_OBSTRUCTION_CODES).concat(WX_DESCRIPTORS);
  allCodes.forEach(code => {
    if (!cleaned.includes(code)) return;
    const severity = WX_PHENOMENA_SEVERITY[code];
    if (severity !== undefined){
      base = base === null ? severity : Math.max(base, severity);
    }
  });
  if (base === null) return null;
  let score = base + intensity + descriptorScore;
  if (vicinity) score -= 0.5;
  return score;
}
function parseObstructionFromWxString(wxString){
  if (!wxString) return null;
  const tokens = String(wxString).trim().split(/\s+/).filter(Boolean);
  const remarkBoundaryIdx = tokens.findIndex(tok => String(tok).toUpperCase() === 'RMK');
  const weatherTokens = remarkBoundaryIdx === -1 ? tokens : tokens.slice(0, remarkBoundaryIdx);
  const candidates = weatherTokens.map(token => {
    const score = wxTokenSeverity(token);
    return score === null ? null : { token, score };
  }).filter(Boolean);
  if (!candidates.length) return null;
  return candidates.reduce((worst, current) => (current.score > worst.score ? current : worst));
}
function obstructionWithCarry(fcsts, seg){
  const direct = parseObstructionFromWxString(seg?.wxString || seg?.rawOb || seg?.raw_text || '');
  if (direct) return direct;
  if (!Array.isArray(fcsts) || !seg) return null;
  const wx = wxWithCarry(fcsts, seg);
  return parseObstructionFromWxString(wx);
}
function classifyFlightRules(ceilingFt, visSm){
  const ceil = (ceilingFt === null || ceilingFt === undefined) ? Infinity : ceilingFt;
  const vis = (visSm === null || visSm === undefined) ? Infinity : visSm;
  if (ceilingFt === null && visSm === null) return { code:'UNK', label:'Unknown', className:'status-unk' };
  if (ceil < 500 || vis < 1) return { code:'LIFR', label:'LIFR', className:'status-lifr' };
  if (ceil < 1000 || vis < 3) return { code:'IFR', label:'IFR', className:'status-ifr' };
  if (ceil < 3000 || vis < 5) return { code:'MVFR', label:'MVFR', className:'status-mvfr' };
  return { code:'VFR', label:'VFR', className:'status-vfr' };
}
function ilsCategory(ceilingFt, visSm){
  const ceil = (ceilingFt === null || ceilingFt === undefined) ? Infinity : ceilingFt;
  const vis = (visSm === null || visSm === undefined) ? Infinity : visSm;
  if (ceil < 100 || vis < 0.3) return { cat:'CAT III', reason:'' };
  if (ceil < 200 || vis < 0.5) return { cat:'CAT II', reason:'' };
  if (ceil < 1000 || vis < 3) return { cat:'CAT I', reason:'' };
  return { cat:'CAT I / Visual', reason:'' };
}
function tafProbLabel(seg){
  const source = `${seg?.changeIndicator || ''} ${seg?.wxString || ''}`.toUpperCase();
  const match = source.match(/PROB(30|40)/);
  if (match) return `PROB${match[1]}`;
  const prob = Number(seg?.probability);
  if (Number.isFinite(prob)){
    if (prob >= 40) return 'PROB40';
    if (prob >= 30) return 'PROB30';
  }
  return '';
}
function tafIsProbSegment(seg){
  return Boolean(tafProbLabel(seg));
}
function tafProbLabelForTime(fcsts, targetMs){
  if (!Array.isArray(fcsts) || !fcsts.length) return '';
  const ordered = tafScopedFcsts(tafOrderedFcsts(fcsts), targetMs);
  const matches = ordered.filter(f => targetMs >= f.timeFrom * 1000 && targetMs < f.timeTo * 1000);
  const segments = matches.length ? matches : [tafSegmentForTime(ordered, targetMs)].filter(Boolean);
  const labels = segments.map(tafProbLabel).filter(Boolean);
  if (labels.includes('PROB40')) return 'PROB40';
  if (labels.includes('PROB30')) return 'PROB30';
  return '';
}
function tafSegmentForTime(fcsts, targetMs, options = {}){
  if (!Array.isArray(fcsts) || !fcsts.length) return null;
  const excludeProb = Boolean(options.excludeProb);
  const ordered = tafScopedFcsts(tafOrderedFcsts(fcsts), targetMs);
  const matches = ordered.filter(f => targetMs >= f.timeFrom * 1000 && targetMs < f.timeTo * 1000);
  const nonProbMatches = excludeProb ? matches.filter(seg => !tafIsProbSegment(seg)) : matches;
  const primaryMatches = nonProbMatches.length ? nonProbMatches : matches;
  const chooseWorst = (segments) => {
    if (!segments.length) return null;
    return segments.reduce((worst, seg) => {
      if (!worst) return seg;
      const ceiling = ceilingWithCarry(ordered, seg);
      const vis = visibilityWithCarryFromOrdered(ordered, seg);
      const worstCeiling = ceilingWithCarry(ordered, worst);
      const worstVis = visibilityWithCarryFromOrdered(ordered, worst);
      const severity = classifyFlightRules(ceiling, vis).code;
      const worstSeverity = classifyFlightRules(worstCeiling, worstVis).code;
      const severityRank = { LIFR: 4, IFR: 3, MVFR: 2, VFR: 1, UNK: 0 };
      const score = severityRank[severity] ?? 0;
      const worstScore = severityRank[worstSeverity] ?? 0;
      if (score !== worstScore) return score > worstScore ? seg : worst;
      const ceilVal = ceiling ?? Infinity;
      const worstCeilVal = worstCeiling ?? Infinity;
      if (ceilVal !== worstCeilVal) return ceilVal < worstCeilVal ? seg : worst;
      const visVal = vis ?? Infinity;
      const worstVisVal = worstVis ?? Infinity;
      if (visVal !== worstVisVal) return visVal < worstVisVal ? seg : worst;
      return seg;
    }, null);
  };
  if (primaryMatches.length){
    return chooseWorst(primaryMatches);
  }
  const findPrior = (list) => [...list].reverse().find(f => f.timeFrom * 1000 <= targetMs);
  const findFuture = (list) => list.find(f => f.timeFrom * 1000 > targetMs);
  const nonProbOrdered = excludeProb ? ordered.filter(seg => !tafIsProbSegment(seg)) : ordered;
  const prior = findPrior(nonProbOrdered);
  if (prior) return prior;
  if (excludeProb){
    const priorAny = findPrior(ordered);
    if (priorAny) return priorAny;
  }
  const future = findFuture(nonProbOrdered);
  if (future) return future;
  if (excludeProb){
    const futureAny = findFuture(ordered);
    if (futureAny) return futureAny;
  }
  return ordered[ordered.length - 1];
}
function worstConditionsFromSegments(ordered, segments, { allowCarriedCeiling = true, allowCarriedVisibility = true } = {}){
  let worstCeiling = null;
  let worstVisibility = null;
  let worstVisibilityRaw = null;
  let worstWind = null;
  let worstObstruction = null;
  let worstWxRaw = '';
  segments.forEach(seg => {
    const ceiling = allowCarriedCeiling
      ? ceilingWithCarry(ordered, seg)
      : (seg?.cloudsExplicit ? extractCeilingFt(seg?.clouds, seg?.vertVis) : null);
    if (ceiling !== null && ceiling !== undefined){
      worstCeiling = worstCeiling === null ? ceiling : Math.min(worstCeiling, ceiling);
    }
    const vis = allowCarriedVisibility
      ? visibilityWithCarryFromOrdered(ordered, seg)
      : (seg?.visibilityExplicit ? parseVisibilityToSM(seg?.visib) : null);
    const visRaw = allowCarriedVisibility
      ? visibilityRawWithCarryFromOrdered(ordered, seg)
      : (seg?.visibilityExplicit ? segmentVisibilityRaw(seg) : null);
    if (vis !== null && vis !== undefined){
      if (worstVisibility === null || vis < worstVisibility){
        worstVisibility = vis;
        worstVisibilityRaw = visRaw ?? worstVisibilityRaw;
      }
    }
    const wind = windWithCarry(ordered, seg);
    if (wind){
      worstWind = compareWindSeverity(worstWind, wind);
    }
    const wxRaw = wxWithCarry(ordered, seg);
    const obstruction = obstructionWithCarry(ordered, seg);
    if (obstruction){
      worstObstruction = worstObstruction
        ? (obstruction.score > worstObstruction.score ? obstruction : worstObstruction)
        : obstruction;
      if (!worstWxRaw || obstruction === worstObstruction){
        worstWxRaw = wxRaw || obstruction.token || worstWxRaw;
      }
    }
  });
  return {
    ceiling: worstCeiling,
    visibility: worstVisibility,
    visibilityRaw: worstVisibilityRaw,
    wind: worstWind,
    obstruction: worstObstruction,
    wxRaw: worstWxRaw
  };
}
function tafWorstConditionsForTime(fcsts, targetMs){
  if (!Array.isArray(fcsts) || !fcsts.length) {
    return {
      ceiling: null,
      visibility: null,
      visibilityRaw: null,
      wind: null,
      obstruction: null,
      prob: { ceiling: null, visibility: null, visibilityRaw: null, wind: null, obstruction: null, skyClear: false },
      segments: []
    };
  }
  const ordered = tafScopedFcsts(tafOrderedFcsts(fcsts), targetMs);
  const matches = ordered.filter(f => targetMs >= f.timeFrom * 1000 && targetMs < f.timeTo * 1000);
  const nonProbMatches = matches.filter(seg => !tafIsProbSegment(seg));
  const segments = nonProbMatches.length
    ? nonProbMatches
    : (matches.length ? matches : [tafSegmentForTime(ordered, targetMs, { excludeProb: true })].filter(Boolean));
  const probSegments = matches.filter(seg => tafIsProbSegment(seg));
  const worst = worstConditionsFromSegments(ordered, segments);
  const probWorst = probSegments.length ? worstConditionsFromSegments(ordered, probSegments, {
    allowCarriedCeiling: false,
    allowCarriedVisibility: false
  }) : {
    ceiling: null,
    visibility: null,
    visibilityRaw: null,
    wind: null,
    obstruction: null,
    wxRaw: ''
  };
  const probSkyClear = probSegments.some(seg => hasSkyClear(seg));
  return {
    ...worst,
    prob: { ...probWorst, skyClear: probSkyClear },
    segments
  };
}
function formatZulu(ms){
  const d = new Date(ms);
  return d.toISOString().slice(0,16).replace('T',' ') + 'Z';
}
function formatZuluHour(ms){
  const d = new Date(ms);
  const hour = String(d.getUTCHours()).padStart(2, '0');
  return `${hour}Z`;
}
function formatZuluHourRange(startMs, endMs){
  const start = new Date(startMs);
  const end = new Date(endMs);
  const startHour = String(start.getUTCHours()).padStart(2, '0');
  const endHour = String(end.getUTCHours()).padStart(2, '0');
  return `${startHour}-${endHour}Z`;
}
function highlightTafSectionForTime(rawTAF, fcsts, targetMs){
  const cleaned = String(rawTAF || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(' ').filter(Boolean);
  if (!tokens.length) return escapeHtml(cleaned);
  const ranges = (Array.isArray(fcsts) ? fcsts : [])
    .filter(seg => Number.isFinite(seg?.timeFrom) && Number.isFinite(seg?.timeTo) && seg.tokenRange && targetMs >= seg.timeFrom * 1000 && targetMs < seg.timeTo * 1000)
    .map(seg => seg.tokenRange)
    .filter(r => Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start);
  if (!ranges.length) return escapeHtml(cleaned);
  const start = Math.min(...ranges.map(r => r.start));
  const end = Math.max(...ranges.map(r => r.end));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return escapeHtml(cleaned);
  const parts = tokens.map((tok, idx) => {
    const safe = escapeHtml(tok);
    return (idx >= start && idx < end) ? `<mark class="taf-highlight">${safe}</mark>` : safe;
  });
  return parts.join(' ');
}
function driverLabelForSegment(seg){
  const change = String(seg?.changeIndicator || '').toUpperCase();
  const probLabel = tafProbLabel(seg);
  if (probLabel){
    return change.includes('TEMPO') ? `${probLabel} TEMPO` : probLabel;
  }
  if (change.includes('BECMG')) return 'BECMG';
  if (change.includes('TEMPO')) return 'TEMPO';
  return 'FROM';
}
function buildTafDriversSummary(fcsts, targetMs, ceiling, visibility, icaoOverride){
  if (!Array.isArray(fcsts) || !fcsts.length) return '';
  const icao = icaoOverride || fcsts?.icaoId || '';
  const ordered = tafScopedFcsts(tafOrderedFcsts(fcsts), targetMs);
  const matches = ordered.filter(f => targetMs >= f.timeFrom * 1000 && targetMs < f.timeTo * 1000);
  const segments = matches.length ? matches : [tafSegmentForTime(ordered, targetMs, { excludeProb: true })].filter(Boolean);
  const baseSegments = segments.filter(seg => !tafIsProbSegment(seg));
  const driverSegments = baseSegments.length ? baseSegments : segments;
  if (!driverSegments.length) return '';
  const drivers = [];
  const addDriver = (seg, valueText) => {
    if (!seg || !valueText) return;
    const label = driverLabelForSegment(seg);
    const timeText = label === 'FROM'
      ? formatZuluHour(seg.timeFrom * 1000)
      : formatZuluHourRange(seg.timeFrom * 1000, seg.timeTo * 1000);
    const key = `${label}|${timeText}`;
    const existing = drivers.find(d => d.key === key);
    if (existing){
      existing.values.push(valueText);
    } else {
      drivers.push({ key, label, timeText, values: [valueText] });
    }
  };
  if (ceiling !== null && ceiling !== undefined){
    const ceilingSeg = driverSegments.find(seg => {
      const segCeiling = ceilingWithCarry(ordered, seg);
      return segCeiling !== null && segCeiling !== undefined && segCeiling === ceiling;
    });
    addDriver(ceilingSeg, `${ceiling}FT`);
  }
  if (visibility !== null && visibility !== undefined){
    const visSeg = driverSegments.find(seg => {
      const segVis = visibilityWithCarryFromOrdered(ordered, seg);
      return segVis !== null && segVis !== undefined && segVis === visibility;
    });
    const visRaw = visSeg ? visibilityRawWithCarryFromOrdered(ordered, visSeg) : null;
    addDriver(visSeg, formatVisibilityDisplay(visibility, visRaw, { icao }));
  }
  return drivers.map(d => `${d.label} ${d.timeText} ${d.values.join(' / ')}`).join(', ');
}
function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}
function pickFirstWeatherRecord(payload, arrayKeys){
  if (!payload) return null;
  if (Array.isArray(payload)) return payload[0] || null;
  if (typeof payload === 'object'){
    for (const key of arrayKeys){
      const list = payload[key];
      if (Array.isArray(list) && list.length) return list[0];
    }
    if (Array.isArray(payload.features) && payload.features.length){
      const feature = payload.features[0];
      return feature?.properties || feature;
    }
  }
  return null;
}
function pickWeatherRecords(payload, arrayKeys){
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.filter(Boolean);
  if (typeof payload === 'object'){
    for (const key of arrayKeys){
      const list = payload[key];
      if (Array.isArray(list) && list.length) return list.filter(Boolean);
    }
    if (Array.isArray(payload.features) && payload.features.length){
      return payload.features
        .map(feature => feature?.properties || feature)
        .filter(Boolean);
    }
  }
  return [];
}
function hasWeatherData(record){
  return Boolean(record?.metar || record?.taf || (record?.metarHistory && record.metarHistory.length));
}
async function fetchJsonWeatherRecord(builders, icao, label, keys){
  for (const buildUrl of builders){
    const url = buildUrl(icao);
    try {
      const payload = await fetchJsonWithCorsFallback(url, 'no-store');
      const record = pickFirstWeatherRecord(payload, keys);
      if (record) return record;
    } catch(err){
      console.warn(`${label} fetch failed for ${icao} at ${url}`, err);
    }
  }
  return null;
}
async function fetchMetarHistory(icao){
  for (const buildUrl of METAR_HISTORY_JSON_ENDPOINTS){
    const url = buildUrl(icao);
    try {
      const payload = await fetchJsonWithCorsFallback(url, 'no-store');
      const records = pickWeatherRecords(payload, ['metars', 'data', 'results']);
      if (records.length) return records;
    } catch(err){
      console.warn(`METAR history fetch failed for ${icao} at ${url}`, err);
    }
  }
  return [];
}
async function fetchWeatherForAirport(icao){
  const [tafJson, metarHistoryRaw] = await Promise.all([
    fetchJsonWeatherRecord(TAF_JSON_ENDPOINTS, icao, 'TAF', ['tafs', 'data', 'results'])
      .catch(() => null),
    fetchMetarHistory(icao).catch(() => [])
  ]);
  let metarJson = Array.isArray(metarHistoryRaw) && metarHistoryRaw.length ? metarHistoryRaw[0] : null;
  if (!metarJson){
    metarJson = await fetchJsonWeatherRecord(METAR_JSON_ENDPOINTS, icao, 'METAR', ['metars', 'data', 'results'])
      .catch(() => null);
  }
  const metarFromText = metarJson ? null : await fetchMetarTextWithFallbacks(icao);
  const tafTxt = tafJson ? null : await fetchTextWithCorsFallback(TAF_TEXT_FALLBACK(icao), 'no-store')
    .then(txt => parseTafText(txt, icao))
    .catch(err => {
      console.warn(`TAF text fallback failed for ${icao}`, err);
      return null;
    });
  const tafFromJson = tafJson
    ? (buildTafFromRaw(tafJson.rawTAF || tafJson.raw_text || tafJson.taf || '', icao, 'feed')
      || normalizeTafPayload(tafJson, icao)
      || tafJson)
    : null;
  let metarHistory = normalizeMetarHistory(metarHistoryRaw, icao);
  const metarFromTextNamed = metarFromText ? { ...metarFromText, name: icao } : null;
  const metarJsonNamed = metarJson ? { ...metarJson, name: icao } : null;
  if (metarJsonNamed){
    metarHistory = normalizeMetarHistory([metarJsonNamed, ...metarHistory], icao);
  }
  if (metarFromTextNamed && !metarHistory.length){
    metarHistory = normalizeMetarHistory([metarFromTextNamed], icao);
  }
  const finalMetar = metarJsonNamed || metarHistory[0] || metarFromTextNamed;
  const finalTaf = tafFromJson || tafTxt;
  const namedMetar = finalMetar ? { ...finalMetar, name: icao } : null;
  const namedTaf = finalTaf ? { ...finalTaf, name: icao } : null;
  const weatherWarning = (!namedMetar && !namedTaf)
    ? `No METAR/TAF found for ${icao}. Check the airport code or try again later.`
    : '';
  return { icao, name: icao, metar: namedMetar, taf: namedTaf, weatherWarning, metarHistory };
}
const weatherCache = new Map();
let weatherPrimeTimer = null;
let weatherPrimeInFlight = false;
let weatherPrimePromise = null;
function cacheWeatherResult(icao, data){
  if (!icao || !data) return;
  weatherCache.set(String(icao).toUpperCase(), { data, fetchedAt: Date.now() });
}
function getCachedWeather(icao){
  const entry = weatherCache.get(String(icao || '').toUpperCase());
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > WEATHER_CACHE_TTL_MS) return null;
  return entry.data;
}
async function getWeatherForAirport(icao, { forceRefresh = false } = {}){
  const code = String(icao || '').toUpperCase();
  if (!forceRefresh){
    const cached = getCachedWeather(code);
    if (hasWeatherData(cached)) return cached;
  }
  let lastResult = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= WEATHER_MAX_ATTEMPTS; attempt += 1){
    try {
      const fresh = await fetchWeatherForAirport(code);
      lastResult = fresh;
      if (hasWeatherData(fresh)){
        cacheWeatherResult(code, fresh);
        return fresh;
      }
    } catch(err){
      lastErr = err;
    }
    if (attempt < WEATHER_MAX_ATTEMPTS) await sleep(WEATHER_RETRY_DELAY_MS);
  }
  const warningPrefix = `Unable to download weather after ${WEATHER_MAX_ATTEMPTS} attempts.`;
  const warningSuffix = lastErr ? ` Last error: ${lastErr.message || lastErr}` : '';
  const result = lastResult ? { ...lastResult } : { icao: code, name: code, metar: null, taf: null, weatherWarning: '' };
  result.weatherWarning = result.weatherWarning || `${warningPrefix}${warningSuffix}`;
  return result;
}
async function primeWeatherCache(airports = WEATHER_PRIME_TARGETS){
  const targets = Array.from(new Set((airports || []).map(code => String(code || '').toUpperCase()).filter(Boolean)));
  if (!targets.length) return null;
  if (weatherPrimeInFlight) return weatherPrimePromise;
  weatherPrimeInFlight = true;
  const run = (async () => {
    try {
      for (let i = 0; i < targets.length; i += WEATHER_PRIME_BATCH_SIZE){
        const batch = targets.slice(i, i + WEATHER_PRIME_BATCH_SIZE);
        await Promise.all(batch.map((icao) => getWeatherForAirport(icao, { forceRefresh: true }).catch((err) => {
          console.warn(`Weather prime failed for ${icao}`, err);
          return null;
        })));
        if (i + WEATHER_PRIME_BATCH_SIZE < targets.length){
          await sleep(WEATHER_PRIME_DELAY_MS);
        }
      }
    } finally {
      weatherPrimeInFlight = false;
      weatherPrimePromise = null;
    }
  })();
  weatherPrimePromise = run;
  return run;
}
function startWeatherPrimeLoop(){
  primeWeatherCache();
  if (weatherPrimeTimer) clearInterval(weatherPrimeTimer);
  weatherPrimeTimer = setInterval(primeWeatherCache, WEATHER_PRIME_REFRESH_INTERVAL_MS);
}
async function fetchWeatherWithPriority(airports, fetcher){
  const targets = Array.from(new Set((airports || []).map(code => String(code || '').toUpperCase()).filter(Boolean)));
  const entries = await Promise.all(targets.map(async (icao) => {
    try {
      const data = await fetcher(icao);
      return [icao, data];
    } catch (err){
      console.warn(`Weather fetch failed for ${icao}`, err);
      return [icao, null];
    }
  }));
  return entries.reduce((acc, [icao, data]) => {
    if (icao) acc[icao] = data;
    return acc;
  }, {});
}
let latestWeatherContext = { assessments: [], weatherMap: {}, rawSources: [], outEl: null, rawEl: null, rawDetails: null };
const metarHistoryPageState = { source: null, trend: null };
function metarHistoryAnchorId(icao){
  const safe = String(icao || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `metar-history-${safe || 'metar'}`;
}
function metarHistoryPageElements(){
  return {
    page: document.getElementById('metar-history-page'),
    body: document.getElementById('metar-history-body'),
    title: document.getElementById('metar-history-title'),
    meta: document.getElementById('metar-history-meta'),
    ceilingBadge: document.getElementById('metar-history-ceiling'),
    visibilityBadge: document.getElementById('metar-history-visibility'),
    closeBtn: document.getElementById('metar-history-close')
  };
}
function findMetarHistorySource(icao){
  const code = String(icao || '').toUpperCase();
  if (code && latestWeatherContext.weatherMap && latestWeatherContext.weatherMap[code]){
    return latestWeatherContext.weatherMap[code];
  }
  const rawSources = latestWeatherContext.rawSources || [];
  if (code){
    const match = rawSources.find(src => String(src?.icao || src?.name || '').toUpperCase() === code);
    if (match) return match;
  }
  return rawSources[0] || null;
}
function applyMetricTrendBadge(el, metric, trend){
  if (!el) return;
  const detail = trend?.details?.[metric];
  const direction = detail?.direction || null;
  const arrow = direction === 'up' ? '↑' : (direction === 'down' ? '↓' : '');
  const cls = direction === 'up'
    ? 'metar-trend-up'
    : (direction === 'down' ? 'metar-trend-down' : 'metar-trend-neutral');
  const labelBase = metric === 'ceiling' ? 'Ceiling' : 'Vis';
  const labelText = arrow ? `${labelBase} ${arrow}` : labelBase;
  const startText = detail?.startMs ? ` since ${formatZulu(detail.startMs)}` : '';
  const ceilingNote = metric === 'ceiling' ? ' No ceiling counts as unlimited.' : '';
  const title = direction
    ? `${labelBase} trend ${direction === 'up' ? 'improving' : 'worsening'}${startText}.${ceilingNote}`
    : `${labelBase} trend unavailable.${ceilingNote}`;
  el.textContent = labelText;
  el.className = `metar-trend-badge ${cls}`;
  el.setAttribute('title', title);
  el.setAttribute('aria-label', title);
  el.dataset.metricHighlight = detail?.startMs ? String(detail.startMs) : '';
}
function renderMetarHistoryBody(highlightMs = null){
  const { body } = metarHistoryPageElements();
  if (!body) return;
  const source = metarHistoryPageState.source;
  const effectiveHighlight = Number.isFinite(highlightMs) ? highlightMs : (metarHistoryPageState.trend?.startMs ?? null);
  if (!source){
    body.innerHTML = '<div class="wx-error">No METAR history available.</div>';
    return;
  }
  body.innerHTML = renderMetarHistoryList(source.metarHistory, source.icao || source.name, { highlightMs: effectiveHighlight });
  const target = body.querySelector('[data-highlight="true"]');
  if (target && target.scrollIntoView){
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
function closeMetarHistoryPage(){
  const { page } = metarHistoryPageElements();
  if (page){
    page.classList.add('hidden');
    page.setAttribute('aria-hidden', 'true');
  }
  setModernPrimaryTab('modern-weather');
  metarHistoryPageState.source = null;
  metarHistoryPageState.trend = null;
}
function openMetarDetailsPanel(icao){
  const els = metarHistoryPageElements();
  if (!els.page) return;
  setModernPrimaryTab('modern-metar-history');
  const source = findMetarHistorySource(icao);
  metarHistoryPageState.source = source;
  metarHistoryPageState.trend = source ? computeMetarTrend(source.metarHistory || [], source.icao || source.name) : null;
  if (!source){
    if (els.title) els.title.textContent = 'METAR history';
    if (els.meta) els.meta.textContent = 'No METAR data available.';
    if (els.body) els.body.innerHTML = '<div class="wx-error">No METAR data available for this airport.</div>';
  } else {
    const displayName = source.icao || source.name || 'Airport';
    if (els.title) els.title.textContent = `METAR history · ${displayName}`;
    const count = (source.metarHistory || []).length;
    const trend = metarHistoryPageState.trend;
    const latestText = trend?.latestMs ? `Latest ${formatZulu(trend.latestMs)}` : 'Latest METAR unavailable';
    if (els.meta) els.meta.textContent = `${count || 'No'} METARs · ${latestText}`;
    applyMetricTrendBadge(els.ceilingBadge, 'ceiling', trend);
    applyMetricTrendBadge(els.visibilityBadge, 'visibility', trend);
    renderMetarHistoryBody(trend?.startMs ?? null);
  }
  els.page.classList.remove('hidden');
  els.page.setAttribute('aria-hidden', 'false');
  els.closeBtn?.focus();
}
function handleMetarHistoryBadgeClick(metric){
  const trend = metarHistoryPageState.trend;
  const highlightMs = trend?.details?.[metric]?.startMs ?? trend?.startMs ?? null;
  renderMetarHistoryBody(highlightMs);
}
function pickLower(a, b){
  if (b === null || b === undefined) return a;
  if (a === null || a === undefined) return b;
  return Math.min(a, b);
}
function pickStrongerWind(a, b){
  if (!b) return a;
  const windStrength = (wind) => {
    if (!wind) return 0;
    const speed = Number(wind.speed || wind.speedKts || 0);
    const gust = Number(wind.gust || wind.gustKts || 0);
    return Math.max(speed, gust, 0);
  };
  return windStrength(b) > windStrength(a) ? b : a;
}
function moreRestrictiveRules(aRules, bRules){
  const order = ['LIFR','IFR','MVFR','VFR','UNK'];
  const idxA = order.indexOf(String(aRules?.code || '').toUpperCase());
  const idxB = order.indexOf(String(bRules?.code || '').toUpperCase());
  if (idxA === -1) return bRules || aRules;
  if (idxB === -1) return aRules || bRules;
  return idxB < idxA ? bRules : aRules;
}
function pickMoreConservativeAssessment(base, alternative){
  if (!alternative || alternative.noResults) return base;
  const merged = { ...base };
  merged.ceiling = pickLower(base.ceiling, alternative.ceiling);
  merged.visibility = pickLower(base.visibility, alternative.visibility);
  if (merged.visibility === alternative.visibility && alternative.visibilityRaw !== undefined){
    merged.visibilityRaw = alternative.visibilityRaw;
  }
  merged.wind = pickStrongerWind(base.wind, alternative.wind);
  merged.obstruction = alternative.obstruction || base.obstruction;
  merged.wx = alternative.wx || base.wx;
  merged.rules = moreRestrictiveRules(base.rules, alternative.rules);
  merged.ils = alternative.ils?.cat ? alternative.ils : merged.ils;
  merged.summary = alternative.summary || base.summary;
  merged.source = alternative.source || base.source;
  merged.sourceDetail = alternative.sourceDetail || base.sourceDetail;
  merged.probFlag = alternative.probFlag || base.probFlag;
  merged.probConditions = alternative.probConditions || base.probConditions;
  merged.probVisibilityRaw = alternative.probVisibilityRaw || base.probVisibilityRaw;
  merged.tafIcons = alternative.tafIcons?.length ? alternative.tafIcons : merged.tafIcons;
  return merged;
}
function metricSnapshotKey(snapshot, metric){
  switch(metric){
  case 'ceiling': return `${snapshot.ceiling ?? ''}|${snapshot.skyClear ? 'SKC' : ''}`;
  case 'visibility': return `${snapshot.visibility ?? ''}|${snapshot.visibilityRaw ?? ''}|${snapshot.visibilityDisplay ?? ''}`;
  case 'wind': return `${snapshot.wind?.dir ?? ''}|${snapshot.wind?.spd ?? ''}|${snapshot.wind?.gst ?? ''}`;
  case 'obstruction': return `${snapshot.obstruction?.token ?? ''}|${snapshot.wx ?? ''}`;
  case 'ils': return `${snapshot.ils?.cat ?? ''}|${snapshot.ils?.reason ?? ''}`;
  case 'drivers': return `${snapshot.summary ?? ''}`;
  default: return JSON.stringify(snapshot || {});
  }
}
function metricSnapshot(assessment, metric){
  switch(metric){
  case 'ceiling': return { ceiling: assessment.ceiling, skyClear: assessment.skyClear };
  case 'visibility': return { visibility: assessment.visibility, visibilityRaw: assessment.visibilityRaw, visibilityDisplay: assessment.visibilityDisplay };
  case 'wind': return { wind: assessment.wind };
  case 'obstruction': return { obstruction: assessment.obstruction, wx: assessment.wx };
  case 'ils': return { ils: assessment.ils };
  case 'drivers': return { summary: assessment.summary };
  default: return {};
  }
}
function applyMetricSnapshot(target, snapshot, metric){
  const updated = { ...target, feedback: { ...(target.feedback || {}) } };
  switch(metric){
  case 'ceiling':
    updated.ceiling = snapshot.ceiling ?? null;
    updated.skyClear = Boolean(snapshot.skyClear);
    break;
  case 'visibility':
    updated.visibility = snapshot.visibility ?? null;
    updated.visibilityRaw = snapshot.visibilityRaw ?? null;
    updated.visibilityDisplay = snapshot.visibilityDisplay ?? '';
    break;
  case 'wind':
    updated.wind = snapshot.wind || null;
    break;
  case 'obstruction':
    updated.obstruction = snapshot.obstruction || null;
    updated.wx = snapshot.wx || '';
    break;
  case 'ils':
    updated.ils = snapshot.ils || updated.ils;
    break;
  case 'drivers':
    updated.summary = snapshot.summary || updated.summary;
    break;
  }
  return updated;
}
function ensureFeedbackSlot(assessment, metric){
  if (!assessment.feedback) assessment.feedback = {};
  if (!assessment.feedback[metric]){
    assessment.feedback[metric] = { state: 'idle', history: [], currentSource: assessment.source || '' };
  }
  return assessment.feedback[metric];
}
function nextMetricCandidate({ assessment, record, metric }){
  if (!record) return null;
  const currentSnapshot = metricSnapshot(assessment, metric);
  const fb = ensureFeedbackSlot(assessment, metric);
  const seenKeys = new Set((fb.history || []).map(h => h.valueKey));
  seenKeys.add(metricSnapshotKey(currentSnapshot, metric));
  const tafView = summarizeWeatherWindow(record, assessment.targetMs, assessment.label, { useDecoders: true, forceSource: 'taf' });
  const metarView = summarizeWeatherWindow(record, assessment.targetMs, assessment.label, { useDecoders: true, forceSource: 'metar' });
  const conservativeTaf = pickMoreConservativeAssessment(assessment, tafView);
  const conservativeMetar = pickMoreConservativeAssessment(assessment, metarView);
  const candidates = [tafView, metarView, conservativeTaf, conservativeMetar].filter(Boolean);
  for (const candidate of candidates){
    const snap = metricSnapshot(candidate, metric);
    const key = metricSnapshotKey(snap, metric);
    if (!seenKeys.has(key)){
      return { candidate, snapshot: snap, key };
    }
  }
  return null;
}
function handleWeatherFeedback(icao, targetMs, metric, action){
  const assessment = latestWeatherContext.assessments.find(a => a.icao === icao && Math.abs((a.targetMs || 0) - targetMs) < 1500);
  const record = latestWeatherContext.weatherMap?.[icao];
  if (!assessment || !record) return;
  ensureFeedbackSlot(assessment, metric);
  const fb = assessment.feedback[metric];
  const currentSnapshot = metricSnapshot(assessment, metric);
  const currentKey = metricSnapshotKey(currentSnapshot, metric);
  const currentSource = fb.currentSource || assessment.source || '';
  if (action === 'up'){
    fb.history.push({ valueKey: currentKey, source: currentSource });
    fb.state = 'accepted';
    renderWeatherResults(latestWeatherContext.outEl, latestWeatherContext.rawEl, latestWeatherContext.assessments, latestWeatherContext.rawSources, { showDecoders: false, enableFeedback: false });
    return;
  }
  if (action === 'flag' || action === 'down'){
    const next = nextMetricCandidate({ assessment, record, metric });
    fb.history.push({ valueKey: currentKey, source: currentSource });
    if (!next){
      fb.state = 'flagged';
      renderWeatherResults(latestWeatherContext.outEl, latestWeatherContext.rawEl, latestWeatherContext.assessments, latestWeatherContext.rawSources, { showDecoders: false, enableFeedback: false });
      return;
    }
    const updated = applyMetricSnapshot(assessment, next.snapshot, metric);
    updated.feedback = { ...assessment.feedback, [metric]: { ...fb, state: 'review', currentSource: next.candidate?.source || fb.currentSource, lastKey: next.key } };
    const nextAssessments = latestWeatherContext.assessments.map(a => (a === assessment ? updated : a));
    latestWeatherContext.assessments = nextAssessments;
    renderWeatherResults(latestWeatherContext.outEl, latestWeatherContext.rawEl, nextAssessments, latestWeatherContext.rawSources, { showDecoders: false, enableFeedback: false });
  }
}
function metarTimeMs(metar){
  if (!metar) return null;
  if (metar.reportTime) return Date.parse(metar.reportTime);
  if (metar.obsTime) return Number(metar.obsTime) * 1000;
  return null;
}
function normalizeMetarHistory(records, icao){
  if (!Array.isArray(records)) return [];
  const seen = new Set();
  const normalized = records
    .map(rec => (rec ? { ...rec, name: rec.name || icao } : null))
    .filter(Boolean)
    .map(rec => ({ rec, ms: metarTimeMs(rec) }))
    .filter(entry => Number.isFinite(entry.ms))
    .sort((a, b) => b.ms - a.ms)
    .reduce((acc, entry) => {
      if (seen.has(entry.ms)) return acc;
      seen.add(entry.ms);
      acc.push(entry.rec);
      return acc;
    }, []);
  return normalized;
}
function renderMetarHistoryList(history, icao, options = {}){
  const normalized = normalizeMetarHistory(history || [], icao);
  if (!normalized.length) return '<div class="value muted-note">No METAR history available.</div>';
  const highlightMs = Number.isFinite(options.highlightMs) ? options.highlightMs : null;
  const items = normalized.map((rec) => {
    const timeMs = metarTimeMs(rec);
    const timeText = formatZulu(timeMs);
    const raw = rec.rawOb || rec.raw_text || rec.text || rec.metar || rec.rawTAF || rec.TAF || rec.METAR || '';
    const isHighlight = highlightMs !== null && Number.isFinite(timeMs) && Math.abs(timeMs - highlightMs) <= 60000;
    const highlightAttr = isHighlight ? ' data-highlight="true"' : '';
    return `<li class="metar-history-item"${highlightAttr}><div class="metar-history-time">${escapeHtml(timeText || '')}</div><div class="metar-history-raw">${escapeHtml(raw || 'N/A')}</div></li>`;
  }).join('');
  return `<ul class="metar-history-list">${items}</ul>`;
}
function metarMetricsFromRecord(metar, icao){
  if (!metar) return null;
  const timeMs = metarTimeMs(metar);
  if (!Number.isFinite(timeMs)) return null;
  const visSource = metar.visib ?? metar.visibility ?? metar.visibility_statute_mi ?? segmentVisibilityRaw(metar);
  const visibility = parseVisibilityToSM(visSource, { icao });
  const ceiling = extractCeilingFt(metar.clouds, metar.vertVis);
  const skyClear = ceiling === null && hasSkyClear(metar);
  const noCeiling = ceiling === null && !skyClear && hasNoCeiling(metar);
  const ceilingValue = ceiling === null ? ((skyClear || noCeiling) ? 100000 : null) : ceiling;
  const visibilityValue = Number.isFinite(visibility) ? visibility : null;
  if (ceilingValue === null && visibilityValue === null) return null;
  return { timeMs, ceiling, visibility, skyClear, ceilingValue, visibilityValue };
}
function metarHistorySeries(history, icao){
  const normalized = normalizeMetarHistory(history, icao);
  return normalized
    .map(m => metarMetricsFromRecord(m, icao))
    .filter(Boolean)
    .sort((a, b) => a.timeMs - b.timeMs);
}
function metricTrendValues(series, metric){
  if (!Array.isArray(series)) return [];
  return series
    .map(entry => (metric === 'ceiling'
      ? { timeMs: entry.timeMs, value: entry.ceilingValue }
      : { timeMs: entry.timeMs, value: entry.visibilityValue }))
    .filter(entry => entry.value !== null && entry.value !== undefined && Number.isFinite(entry.timeMs));
}
function trailingMetricTrend(values, { minDelta, noise }){
  if (!Array.isArray(values) || !values.length) return { direction: null, startIdx: 0 };
  const lastIdx = values.length - 1;
  let direction = null;
  let startIdx = lastIdx;
  for (let i = values.length - 2; i >= 0; i -= 1){
    const change = values[i + 1].value - values[i].value;
    const changeDir = Math.abs(change) <= noise ? 'flat' : (change > 0 ? 'up' : 'down');
    if (!direction){
      if (changeDir === 'flat'){
        startIdx = i;
        continue;
      }
      direction = changeDir;
      startIdx = i;
      continue;
    }
    if (changeDir === 'flat' || changeDir === direction){
      startIdx = i;
      continue;
    }
    break;
  }
  const delta = values[lastIdx].value - values[startIdx].value;
  const trendDirection = Math.abs(delta) >= minDelta ? (delta > 0 ? 'up' : 'down') : null;
  return { direction: trendDirection, startIdx, delta };
}
function metricTrendDetails(series, metric){
  const values = metricTrendValues(series, metric);
  if (!values.length) return { direction: null, startMs: null, endMs: null, points: [] };
  if (values.length === 1){
    return {
      direction: null,
      startMs: values[0].timeMs,
      endMs: values[0].timeMs,
      points: [values[0]]
    };
  }
  const thresholds = metric === 'ceiling'
    ? { minDelta: METAR_TREND_MIN_CHANGE_CEILING_FT, noise: METAR_TREND_NOISE_CEILING_FT }
    : { minDelta: METAR_TREND_MIN_CHANGE_VIS_SM, noise: METAR_TREND_NOISE_VIS_SM };
  const { direction, startIdx } = trailingMetricTrend(values, thresholds);
  const startPoint = values[startIdx];
  const endPoint = values[values.length - 1];
  const points = values.slice(startIdx);
  return { direction, startMs: startPoint.timeMs, endMs: endPoint.timeMs, points };
}
function computeMetarTrend(history, icao){
  const series = metarHistorySeries(history, icao);
  const ceilingTrend = metricTrendDetails(series, 'ceiling');
  const visibilityTrend = metricTrendDetails(series, 'visibility');
  const ups = [ceilingTrend.direction, visibilityTrend.direction].filter(dir => dir === 'up').length;
  const downs = [ceilingTrend.direction, visibilityTrend.direction].filter(dir => dir === 'down').length;
  const direction = ups && !downs ? 'up' : (downs && !ups ? 'down' : null);
  const trendAnchors = [ceilingTrend, visibilityTrend].filter(t => t.direction === direction && t.startMs !== null);
  const startMs = trendAnchors.length
    ? Math.min(...trendAnchors.map(t => t.startMs))
    : null;
  const latestMs = series.length ? series[series.length - 1].timeMs : null;
  return {
    direction,
    metrics: { ceiling: ceilingTrend.direction, visibility: visibilityTrend.direction },
    hasHistory: series.length > 0,
    startMs,
    latestMs,
    details: { ceiling: ceilingTrend, visibility: visibilityTrend }
  };
}
function summarizeWeatherWindow(airportData, targetMs, label, options = {}){
  const forceSource = options.forceSource || null;
  const forceMetar = forceSource === 'metar' ? true : Boolean(options.forceMetar);
  const forceTaf = forceSource === 'taf';
  const useDecoders = options.useDecoders !== false;
  const hasMetar = Boolean(airportData?.metar);
  const airportIcao = airportData?.icao || '';
  const displayName = airportIcao || airportData?.name || '';
  let tafIcons = [false, false, false];
  let tafSeg = null;
  let tafProbLabelText = '';
  let tafFcsts = null;
  let tafDisagreement = false;
  if (!forceMetar || !hasMetar){
    try {
      if (useDecoders){
        const tafOutcome = tafConsensusForTime(airportData?.tafDecodes || [], targetMs);
        tafSeg = tafOutcome.segment;
        tafIcons = tafOutcome.icons;
        tafProbLabelText = tafOutcome.probLabel || '';
        tafFcsts = tafOutcome.fcsts || null;
        tafDisagreement = Boolean(tafOutcome.disagreement);
      }
    } catch(err){
      console.warn(err?.message || err);
    }
    if (!tafSeg){
      tafSeg = tafSegmentForTime(airportData?.taf?.fcsts, targetMs, { excludeProb: true });
      tafProbLabelText = tafProbLabelForTime(airportData?.taf?.fcsts, targetMs);
      tafFcsts = airportData?.taf?.fcsts || null;
    }
  } else {
    tafIcons = [null, null, null];
  }
  if (tafDisagreement){
    return {
      label,
      icao: airportData?.icao || '',
      name: displayName || airportData?.name || airportData?.icao || '',
      targetMs,
      targetText: formatZulu(targetMs),
      noResults: true,
      noResultsReason: 'TAF decoders disagree. No results shown for this airport.',
      tafIcons
    };
  }
  const metarMs = metarTimeMs(airportData.metar);
  const metarIsCurrent = metarMs ? Math.abs(targetMs - metarMs) <= 90 * 60000 : false;
  const forceTafOnly = forceTaf && tafSeg;
  const useMetar = forceTafOnly ? false : ((forceMetar && hasMetar) || (metarIsCurrent && (!tafSeg || targetMs <= metarMs + 45 * 60000)));
  const segment = useMetar ? airportData.metar : (tafSeg || airportData.metar);
  const source = useMetar ? 'METAR' : (tafSeg ? 'TAF' : 'METAR');
  const sourceDetail = source === 'TAF' && tafProbLabelText ? `${source} · ${tafProbLabelText}` : source;
  const probFlag = source === 'TAF' ? tafProbLabelText : '';
  const tafWorst = source === 'TAF' ? tafWorstConditionsForTime(tafFcsts || [], targetMs) : null;
  const tafProbConditions = source === 'TAF' ? tafWorst?.prob || null : null;
  const ceiling = source === 'TAF' ? tafWorst.ceiling : extractCeilingFt(segment?.clouds, segment?.vertVis);
  const vis = source === 'TAF' ? tafWorst.visibility : parseVisibilityToSM(segment?.visib, { icao: airportIcao });
  const visRaw = source === 'TAF' ? tafWorst.visibilityRaw : segmentVisibilityRaw(segment);
  const probVisRaw = source === 'TAF' ? tafProbConditions?.visibilityRaw ?? null : null;
  const wind = source === 'TAF' ? tafWorst.wind : extractWindFromSegment(segment);
  const obstruction = source === 'TAF'
    ? tafWorst.obstruction
    : parseObstructionFromWxString(segment?.wxString || segment?.rawOb || segment?.raw_text || segment?.text || '');
  const rules = classifyFlightRules(ceiling, vis);
  const ils = ilsCategory(ceiling, vis);
  const skyClear = ceiling === null && hasSkyClear(segment);
  const wxRaw = source === 'TAF'
    ? wxWithCarry(tafFcsts || [], segment)
    : (segment?.wxString || (Array.isArray(segment?.weather) ? segment.weather.join(' ') : ''));
  const wx = wxRaw ? wxRaw : 'None reported';
  const windowText = source === 'TAF' && tafSeg
    ? `${formatZulu(tafSeg.timeFrom * 1000)} → ${formatZulu(tafSeg.timeTo * 1000)}`
    : (metarMs ? `Obs ${formatZulu(metarMs)}` : 'Timing unavailable');
  const metarTrend = computeMetarTrend(
    airportData?.metarHistory || [],
    airportIcao
  );
  const reasonBits = [];
  if (ceiling !== null) reasonBits.push(`Ceiling ${ceiling} ft`);
  if (ceiling === null && skyClear) reasonBits.push('SKC');
  if (vis !== null) reasonBits.push(`Vis ${formatVisibilityDisplay(vis, visRaw, { icao: airportIcao })}`);
  if (wx && wx !== 'None reported') reasonBits.push(wx);
  if (!segment) reasonBits.push('No METAR/TAF available');
  const driversSummary = source === 'TAF'
    ? buildTafDriversSummary(tafFcsts || [], targetMs, ceiling, vis, airportIcao)
    : '';
    return {
      label,
      icao: airportData.icao,
      name: displayName || airportData.name || airportData.icao,
      targetMs,
      targetText: formatZulu(targetMs),
      source,
      sourceDetail,
      windowText,
    ceiling,
    visibility: vis,
    visibilityRaw: visRaw,
    visibilityDisplay: formatVisibilityDisplay(vis, visRaw, { icao: airportIcao }),
    wind,
    obstruction,
    rules,
    ils,
    skyClear,
    wx,
    probFlag,
    probConditions: tafProbConditions,
    probVisibilityRaw: probVisRaw,
    probVisibilityDisplay: (tafProbConditions && tafProbConditions.visibility !== null && tafProbConditions.visibility !== undefined)
      ? formatVisibilityDisplay(tafProbConditions.visibility, probVisRaw, { icao: airportIcao })
      : '',
    tafIcons,
    metarTrend,
    summary: driversSummary || reasonBits.join(' · ') || 'No significant weather decoded'
  };
}
function renderWeatherResults(outEl, rawEl, assessments, rawSources, options = {}){
  if (!outEl) return;
  if (!assessments || !assessments.length){
    outEl.innerHTML = '<div class="wx-error">No weather data available.</div>';
    if (rawEl) rawEl.innerHTML = '';
    return;
  }
  const showDecoders = options.showDecoders === true;
  const buildWxTokens = (wxRaw, fallbackToken) => {
    const tokens = extractWeatherTokens(wxRaw);
    if (fallbackToken){
      const key = fallbackToken.toUpperCase();
      if (!tokens.some(tok => tok.toUpperCase() === key)){
        tokens.unshift(fallbackToken);
      }
    }
    return tokens;
  };
  const selectToken = (tokens, candidates) => {
    const upperCandidates = (candidates || []).map(code => code.toUpperCase());
    return (tokens || []).find(tok => upperCandidates.some(code => tok.toUpperCase().includes(code))) || '';
  };
  const renderMetarTrendBadge = (trend, icao) => {
    if (!trend || !trend.hasHistory) return '';
    const arrow = trend.direction === 'up' ? '↑' : (trend.direction === 'down' ? '↓' : '');
    const cls = trend.direction === 'up'
      ? 'metar-trend-up'
      : (trend.direction === 'down' ? 'metar-trend-down' : 'metar-trend-neutral');
    const startText = trend.startMs ? ` since ${formatZulu(trend.startMs)}` : '';
    const title = trend.direction === 'up'
      ? `METAR ceiling/visibility improving${startText}. Tap to view METAR history.`
      : (trend.direction === 'down'
        ? `METAR ceiling/visibility worsening${startText}. Tap to view METAR history.`
        : 'No clear ceiling/visibility trend. Tap to view METAR history.');
    const labelText = arrow ? `METAR ${arrow}` : 'METAR';
    const dataIcao = escapeHtml(String(icao || ''));
    return `<span class="metar-trend-badge ${cls}" role="button" tabindex="0" data-icao="${dataIcao}" aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}">${escapeHtml(labelText)}</span>`;
  };
  const formatWxTokens = (tokens) => {
    const precip = selectToken(tokens, WX_PRECIP_CODES);
    const obstruction = selectToken(tokens, WX_OBSTRUCTION_CODES);
    const parts = [];
    if (precip) parts.push(precip);
    if (obstruction && obstruction !== precip) parts.push(obstruction);
    return parts.join(' ');
  };
  const renderWxBox = (assessment, metricKey, labelHtml, valueHtml) => {
    return `<div class="wx-box"><div class="label">${labelHtml}</div><div class="value">${valueHtml}</div></div>`;
  };
  const attachMetarBadgeHandlers = () => {
    if (!outEl) return;
    const badges = outEl.querySelectorAll('.metar-trend-badge');
    badges.forEach((badge) => {
      const activate = () => openMetarDetailsPanel(badge.dataset.icao || '');
      addTapListener(badge, activate);
      badge.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' '){
          ev.preventDefault();
          activate();
        }
      });
    });
  };
  const attachMetarHistoryOpeners = () => {
    if (!rawEl) return;
    const buttons = rawEl.querySelectorAll('[data-open-metar-history]');
    buttons.forEach((btn) => {
      const activate = () => openMetarDetailsPanel(btn.dataset.openMetarHistory || '');
      addTapListener(btn, activate);
      btn.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' '){
          ev.preventDefault();
          activate();
        }
      });
    });
  };
  const cards = assessments.map(a => {
    const airportLabel = escapeHtml(a.icao || a.name || '');
    const metarTrendBadge = renderMetarTrendBadge(a.metarTrend, a.icao);
    const statusContent = `<div class="status-row">
          <span class="status-badge ${a.rules?.className || ''}">${escapeHtml(a.rules?.label || '')}</span>
          ${metarTrendBadge}
          ${a.probFlag ? `<span class="prob-flag ${a.rules?.className || ''}">${escapeHtml(a.probFlag)}</span>` : ''}
        </div>`;
    const statusArea = `<div class="wx-actions">${statusContent}</div>`;
    if (a.noResults){
      return `<div class="weather-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px">${escapeHtml(a.label)}</div>
          <div style="font-weight:800;font-size:18px">${airportLabel}</div>
            <div class="wx-meta">
              <span>${escapeHtml(a.targetText || '')}</span>
            </div>
          </div>
        </div>
        <div class="wx-error" style="margin-top:12px">${escapeHtml(a.noResultsReason || 'No results available for this airport.')}</div>
      </div>`;
    }
    const prob = a.probConditions || {};
    const probCeilingText = (prob.ceiling !== null && prob.ceiling !== undefined)
      ? `${prob.ceiling} ft`
      : (prob.skyClear ? 'SKC' : '');
    const probVisText = a.probVisibilityDisplay
      || ((prob.visibility !== null && prob.visibility !== undefined)
        ? formatVisibilityDisplay(prob.visibility, prob.visibilityRaw ?? a.probVisibilityRaw, { icao: a.icao })
        : '');
    const probWindText = prob.wind ? formatWind(prob.wind) : '';
    const probWxText = (prob.wxRaw || '').trim();
    const probObstructionText = prob.obstruction?.token ? prob.obstruction.token : stripVisibilityFromWxText(probWxText);
    const withProbSuffix = (baseText, probText) => {
      const normalize = (text) => String(text || '').trim().replace(/\s+/g, ' ').toUpperCase();
      const baseNorm = normalize(baseText);
      const probNorm = normalize(probText);
      const hasBase = Boolean(baseNorm);
      const hasProb = Boolean(probNorm);
      if (!hasProb && !hasBase) return '';
      if (!hasProb) return baseText;
      if (!hasBase) return probText;
      if (baseNorm === probNorm) return baseText;
      return `${baseText} (${probText})`;
    };
    const ceilTxt = (a.ceiling !== null && a.ceiling !== undefined)
      ? `${a.ceiling} ft`
      : (a.skyClear ? 'SKC' : 'No ceiling');
    const visTxt = a.visibilityDisplay || formatVisibilityDisplay(a.visibility, a.visibilityRaw, { icao: a.icao });
    const windTxt = formatWind(a.wind);
    const ceilDisplay = withProbSuffix(ceilTxt, probCeilingText);
    const visDisplay = withProbSuffix(visTxt, probVisText);
    const windDisplay = withProbSuffix(windTxt, probWindText);
    const ceilDisplayHtml = `${escapeHtml(ceilDisplay)}`;
    const visDisplayHtml = `${escapeHtml(visDisplay)}`;
    const baseWxTokens = buildWxTokens(a.wx, a.obstruction?.token);
    const probWxTokens = buildWxTokens(prob.wxRaw || probObstructionText, prob.obstruction?.token);
    const baseWxDisplay = formatWxTokens(baseWxTokens);
    const probWxDisplay = formatWxTokens(probWxTokens);
    const obstructionDisplay = withProbSuffix(baseWxDisplay, probWxDisplay) || '—';
    const ilsReason = a.ils?.reason ? `<div style="font-size:12px;color:var(--muted);margin-top:4px">${escapeHtml(a.ils.reason)}</div>` : '';
    return `<div class="weather-card">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px">${escapeHtml(a.label)}</div>
          <div style="font-weight:800;font-size:18px">${airportLabel}</div>
          <div class="wx-meta">
            <span>${escapeHtml(a.targetText)}</span>
            <span>${escapeHtml(a.sourceDetail || a.source)} · ${escapeHtml(a.windowText)}</span>
          </div>
        </div>
        ${statusArea}
      </div>
      <div class="wx-metric">
        ${renderWxBox(a, 'ceiling', labelWithInfo('Ceiling', INFO_COPY.weather.ceiling), ceilDisplayHtml)}
        ${renderWxBox(a, 'visibility', labelWithInfo('Visibility', INFO_COPY.weather.visibility), visDisplayHtml)}
        ${renderWxBox(a, 'wind', labelWithInfo('Wind', INFO_COPY.weather.wind), escapeHtml(windDisplay))}
        ${renderWxBox(a, 'obstruction', labelWithInfo('Precip/Obstruction', INFO_COPY.weather.obstruction), escapeHtml(obstructionDisplay))}
        ${renderWxBox(a, 'ils', 'ILS guidance', `<span class=\"ils-badge\">${escapeHtml(a.ils.cat)}</span>${ilsReason}`)}
        ${renderWxBox(a, 'drivers', 'Drivers', `<span style=\"font-size:14px;line-height:1.4\">${escapeHtml(a.summary)}</span>`)}
        ${showDecoders ? renderWxBox(a, 'taf-decoders', 'TAF decoders', renderDecoderIcons(a.tafIcons)) : ''}
      </div>
    </div>`;
  }).join('');
  outEl.innerHTML = cards;
  attachMetarBadgeHandlers();
  if (rawEl){
    const assessmentsByIcao = assessments.reduce((acc, entry) => {
      const key = entry?.icao;
      if (!key) return acc;
      if (!acc[key]) acc[key] = [];
      acc[key].push(entry);
      return acc;
    }, {});
    const rawHtml = (rawSources || []).map(src => {
      const anchorId = metarHistoryAnchorId(src?.icao || src?.name || '');
      return `
      <div class="wx-box" id="${escapeHtml(anchorId)}">
        <div class="label">${escapeHtml(src.icao || src.name || '')}</div>
        <div class="value" style="font-size:13px;line-height:1.4">METAR: ${escapeHtml(src.metar?.rawOb || 'N/A')}</div>
        <div class="value" aria-hidden="true" style="height:8px"></div>
        ${(assessmentsByIcao[src.icao] || [null]).map(a => {
          const tafText = src.taf?.rawTAF || '';
          const highlighted = a ? (highlightTafSectionForTime(tafText, src.taf?.fcsts || [], a.targetMs) || escapeHtml(tafText || 'N/A')) : escapeHtml(tafText || 'N/A');
          const label = a ? `${escapeHtml(a.label)} · ${escapeHtml(a.targetText || '')}` : 'TAF';
          return `<div class="value" style="font-size:13px;line-height:1.4">TAF (${label}): ${highlighted || 'N/A'}</div>`;
        }).join('')}
        <div class="wx-actions">
          <button class="wx-flag wx-flag-compact" type="button" data-open-metar-history="${escapeHtml(src.icao || src.name || '')}">Open METAR history</button>
        </div>
      </div>
    `;
    }).join('');
    rawEl.innerHTML = rawHtml;
    attachMetarHistoryOpeners();
  }
}
async function runWeatherWorkflow(opts){
  return runWeatherWorkflowAttempt(opts, 1);
}
async function runWeatherWorkflowAttempt({ depId, arrId, depHrsId, arrHrsId, outId, rawId }, attempt){
  const outEl = document.getElementById(outId);
  const rawEl = document.getElementById(rawId);
  const rawDetails = rawEl?.closest('details');
  const useDecoders = true;
  const attemptMsg = attempt === 1
    ? 'Fetching METAR/TAF and decoding…'
    : `Retrying weather fetch (attempt ${attempt}/${WEATHER_MAX_ATTEMPTS})…`;
  if (outEl) outEl.innerHTML = `<div class="muted-note">${escapeHtml(attemptMsg)}</div>`;
  if (rawEl) rawEl.innerHTML = '';
  if (rawDetails){
    rawDetails.open = false;
    rawDetails.classList.add('hidden');
  }
  try {
    const depCode = document.getElementById(depId)?.value || '';
    const arrCode = document.getElementById(arrId)?.value || '';
    const depHrs = parseFloat(document.getElementById(depHrsId)?.value || '0');
    const arrHrs = parseFloat(document.getElementById(arrHrsId)?.value || '0');
    if (!Number.isFinite(depHrs) || depHrs < 0) throw new Error('Departure time must be zero or greater.');
    if (!Number.isFinite(arrHrs) || arrHrs < 0) throw new Error('Arrival time must be zero or greater.');
    const [depIcao, arrIcao] = await Promise.all([resolveAirportCode(depCode), resolveAirportCode(arrCode)]);
    const uniqueIcao = Array.from(new Set([depIcao, arrIcao].filter(Boolean)));
    const weatherMap = await fetchWeatherWithPriority(uniqueIcao, (icao) => getWeatherForAirport(icao));
    const now = Date.now();
    const baseAssessments = [
      summarizeWeatherWindow(
        weatherMap[depIcao],
        now + depHrs * 3600000,
        'Departure field',
        { forceMetar: depHrs < DEPARTURE_METAR_THRESHOLD_HRS, useDecoders }
      ),
      summarizeWeatherWindow(weatherMap[arrIcao], now + arrHrs * 3600000, 'Arrival field', { useDecoders })
    ];
    const normalizedAssessments = baseAssessments.map(a => ({ ...a, feedback: a.feedback || {} }));
    const rawSources = uniqueIcao.map(c => weatherMap[c]).filter(Boolean);
    renderWeatherResults(outEl, rawEl, normalizedAssessments, rawSources, { showDecoders: false, enableFeedback: false });
    latestWeatherContext = { assessments: normalizedAssessments, weatherMap, rawSources, outEl, rawEl, rawDetails };
    if (rawDetails && rawSources.length){
      rawDetails.classList.remove('hidden');
    }
  } catch(err){
    console.error(err);
    const message = err.message || 'Weather lookup failed';
    const shouldRetry = /no\s+(metar\/)?taf/i.test(message);
    if (shouldRetry && attempt < WEATHER_MAX_ATTEMPTS){
      if (outEl) outEl.innerHTML = `<div class="muted-note">Attempt ${attempt} failed: ${escapeHtml(message)}. Retrying (${attempt + 1}/${WEATHER_MAX_ATTEMPTS})…</div>`;
      await sleep(WEATHER_RETRY_DELAY_MS);
      return runWeatherWorkflowAttempt({ depId, arrId, depHrsId, arrHrsId, outId, rawId }, attempt + 1);
    }
    if (outEl) outEl.innerHTML = `<div class="wx-error">Attempt ${attempt}: ${escapeHtml(message)}</div>`;
    if (rawEl) rawEl.innerHTML = '';
  }
}

// --- Renderers ---
const INFO_COPY = {
  annual: {
    annualGross: 'Hourly rate (seat/aircraft/year/step) multiplied by average monthly credit hours for each month, with step progression when enabled. Projected years (2027+) use the selected scenario growth rates (Year 4 repeats for 2031).',
    annualNet: 'Annual gross minus tax, CPP/QPP, EI, pension, union dues, health premiums and ESOP contributions, plus the after-tax employer ESOP match.',
    monthlyGross: 'One-month gross derived from the annual projection using your average monthly hours (projected years 2027+ follow the selected scenario growth rates).',
    monthlyNet: 'Projected monthly net after tax, CPP/QPP, EI, pension, union dues, health and ESOP, plus the employer ESOP match (no cheque split).',
    taxReturn: 'Estimated refund (positive) or balance owing (negative) based on annualized withholding across two monthly paycheques (advance annualized at 12, second cheque annualized at 24, pension based on full month gross), plus RRSP and union dues tax savings.',
    hourlyRate: 'Pay table rate for each segment of the year (with XLR when toggled), including the progression date increase. Projected years (2027+) reflect the selected scenario growth rates and slope anchoring for FO/RP.',
    incomeTax: 'Total annual federal and provincial income tax after pension credits (RRSP and union dues savings are reflected in the tax return estimate).',
    cpp: 'Annual CPP/QPP contributions on employment income up to the yearly maximum.',
    ei: 'Annual EI premiums based on insurable earnings up to the yearly maximum.',
    pension: 'Employee pension contributions using the current pension rate applied to gross pay.',
    esopContribution: 'Employee ESOP contributions at the selected percentage of gross, capped at $30,000 annually.',
    esopMatch: 'Employer ESOP match (30% of your contribution) shown after estimated tax on the match.',
    union: 'Estimated annual union dues derived from monthly dues across all months.',
    health: 'Annualized health deduction at the monthly premium rate.'
  },
  advanced: {
    returnEstimate: 'Estimated refund (positive) or balance owing (negative) using annual payroll withholding plus the additional income, deductions, dividends and donation credits entered.',
    adjustedTaxable: 'Taxable income after RRSP, union dues and other deductions, plus dividend gross-up and taxable capital gains.',
    taxLiability: 'Estimated federal and provincial income tax before comparing to payroll withholding.',
    withholding: 'Annualized tax withheld with advances annualized at 12 cheques, second cheques at 24 cheques, and pension based on full month gross.',
    donationCredit: 'Donation credit estimated using base federal and provincial credit rates.',
    dividendGrossUp: 'Dividend gross-up added to taxable income for eligible and non-eligible dividends.',
    capitalGainsTaxable: 'Taxable portion of net capital gains after capital losses (50% inclusion rate).'
  },
  monthly: {
    hourlyRate: 'Pay table rate for the chosen seat, aircraft, year and step (including XLR when toggled). Projected years (2027+) follow the selected growth scenario and FO/RP slope anchoring.',
    credits: 'Monthly credit hours plus minutes (converted to hours) paid at regular rate up to 85 hours.',
    voCredits: 'VO credit hours and minutes (converted to hours) that are always paid at double time.',
    gross: 'Monthly gross combining regular hours at the hourly rate, overtime beyond 85 hours at double time and VO credits at double time.',
    net: 'Monthly take-home after tax, CPP/QPP, EI, health, union dues, pension and ESOP, plus the ESOP match and TAFB.',
    payAdvance: 'Requested advance minus tax/CPP/QPP/EI withheld on that advance cheque alone (annualized over 12 similar paycheques).',
    secondPay: 'Remaining gross after the advance minus tax/CPP/QPP/EI calculated on the second cheque and fixed deductions (no ESOP match added), plus TAFB.',
    incomeTax: 'Total monthly income tax withheld across the advance and second pay cheques.',
    cpp: 'Estimated monthly CPP/QPP contributions toward the annual maximum.',
    ei: 'Estimated monthly EI premiums toward the annual maximum.',
    pension: 'Employee pension contributions for the month at the current pension rate.',
    health: 'Fixed monthly health deduction.',
    esop: 'Employee ESOP deduction for the month at the selected percentage of gross (capped to the monthly portion of $30,000).',
    esopMatch: 'Employer ESOP match for the month (30% of your contribution) reduced by estimated tax on the match.',
    union: 'Estimated monthly union dues based on seat, aircraft, year and hours.',
    tafb: 'Per diem hours paid at $5.427/hr added after tax.',
    marginalFed: 'Marginal federal tax rate based on annualized taxable income (gross minus pension).',
    marginalProv: 'Marginal provincial/territorial tax rate based on annualized taxable income.'
  },
  vo: {
    hourlyRate: 'Pay table rate for the chosen seat, aircraft, year and step (including XLR when toggled). Projected years (2027+) follow the selected growth scenario and FO/RP slope anchoring.',
    hours: 'Entered VO credits converted to paid hours (credits × 2 at double time).',
    gross: 'VO pay hours multiplied by the hourly rate.',
    net: 'Gross VO pay reduced by the combined marginal federal and provincial rates.',
    marginalFed: 'Marginal federal tax rate based on the VO gross amount.',
    marginalProv: 'Marginal provincial/territorial tax rate based on the VO gross amount.'
  },
  weather: {
    ceiling: 'Lowest ceiling across overlapping non-PROB TAF segments at the selected time. PROB30/40 ceilings appear in brackets.',
    visibility: 'Lowest visibility across overlapping non-PROB TAF segments at the selected time. PROB30/40 visibility appears in brackets.',
    wind: 'Strongest sustained wind or gust across overlapping non-PROB TAF segments at the selected time. PROB30/40 winds appear in brackets.',
    obstruction: 'Worst precipitation or visibility obstruction token across overlapping non-PROB TAF segments at the selected time. PROB30/40 tokens appear in brackets.'
  },
  duty: {
    maxFdp: 'Maximum flight duty period based on the selected rule set (ALPA or FOM). ALPA uses the FDP start time converted to YYZ local, planned sectors/legs, zone selection, time zone difference between departure and arrival (<4 vs ≥4 column), and augmentation/rest facility limits from Tables A–C; deadhead at end of duty day applies Table D limits or the +3 hour extension cap (18 hours). FOM uses the published FDP tables for unaugmented/augmented limits without zone or time-zone adjustments.',
    endUtc: 'FDP end time in UTC using the calculated maximum FDP added to the departure local start time (day offset shown when crossing midnight UTC).',
    brakesSet: 'Brakes set time in UTC calculated as FDP end minus 15 minutes (day offset shown when crossing midnight UTC). This is shown for ALPA duty results only.',
    basis: 'Rule bucket used to determine the maximum FDP from the tables and whether deadhead rules were applied.'
  },
  rest: {
    minimum: 'Minimum rest required based on home base/away status (inferred from the layover code; YYZ/CYYZ treated as home base), time zone differences (calculated from the layover location vs YYZ using today’s date), augmentation, and UOC/disruptive schedule rules. Enter the actual FDP duration, including any deadhead extension, to reflect Table D impacts.',
    basis: 'Rule bucket used to set the base rest requirement.',
    extras: 'Additional requirements such as disruptive schedule local night’s rest or UOC extensions.'
  }
};

function infoBubble(text){
  const safe = String(text || '').replace(/"/g, '&quot;');
  return `<span class="info-hover" aria-label="${safe}"><span class="info-icon" aria-hidden="true">i</span><span class="tooltip">${safe}</span></span>`;
}

function labelWithInfo(title, desc){
  return `${title} ${infoBubble(desc)}`;
}

function getAnnualParams(isModern){
  if (isModern){
    return {
      seat: document.getElementById('modern-seat').value,
      ac: document.getElementById('modern-ac').value,
      year: +document.getElementById('modern-year').value,
      stepInput: +document.getElementById('modern-step').value,
      tieOn: document.getElementById('modern-tie').checked,
      xlrOn: document.getElementById('modern-xlr').checked,
      avgMonthlyHours: +document.getElementById('modern-avgHrs').value,
      province: document.getElementById('modern-prov').value,
      esopPct: +document.getElementById('modern-esop').value,
      rrsp: +document.getElementById('modern-adv-rrsp').value
    };
  }
  return {
    seat: document.getElementById('seat').value,
    ac: document.getElementById('ac').value,
    year: +document.getElementById('year').value,
    stepInput: +document.getElementById('step').value,
    tieOn: document.getElementById('tie').checked,
    xlrOn: document.getElementById('xlr').checked,
    avgMonthlyHours: +document.getElementById('avgHrs').value,
    province: document.getElementById('prov').value,
    esopPct: +document.getElementById('esop').value,
    rrsp: +document.getElementById('rrsp').value
  };
}

function getAdvancedInputs(isModern){
  const prefix = isModern ? 'modern-' : '';
  return {
    eligibleDividends: +document.getElementById(`${prefix}adv-div-eligible`)?.value || 0,
    nonEligibleDividends: +document.getElementById(`${prefix}adv-div-noneligible`)?.value || 0,
    capitalGains: +document.getElementById(`${prefix}adv-capgains`)?.value || 0,
    capitalLosses: +document.getElementById(`${prefix}adv-caploss`)?.value || 0,
    donations: +document.getElementById(`${prefix}adv-donations`)?.value || 0,
    otherIncome: +document.getElementById(`${prefix}adv-other-income`)?.value || 0,
    otherDeductions: +document.getElementById(`${prefix}adv-other-deductions`)?.value || 0,
    unionDues: +document.getElementById(`${prefix}adv-union-dues`)?.value || 0,
    rrsp: +document.getElementById(`${prefix}adv-rrsp`)?.value || 0
  };
}

function syncAdvancedRrsp(isModern){
  const source = document.getElementById(isModern ? 'modern-rrsp' : 'rrsp');
  const target = document.getElementById(isModern ? 'modern-adv-rrsp' : 'adv-rrsp');
  if (!source || !target) return;
  target.value = source.value || 0;
}

function syncAdvancedUnionDues(isModern, baseResult){
  const target = document.getElementById(isModern ? 'modern-adv-union-dues' : 'adv-union-dues');
  if (!target || !baseResult) return;
  target.value = baseResult.union_annual ?? Math.max(0, (baseResult.monthly?.union_dues || 0) * 12);
}

function normalizeAmount(value){
  return Math.max(0, +value || 0);
}

function computeAdvancedTaxReturn({ baseParams, baseResult, advancedParams }){
  const eligibleDividends = normalizeAmount(advancedParams.eligibleDividends);
  const nonEligibleDividends = normalizeAmount(advancedParams.nonEligibleDividends);
  const capitalGains = normalizeAmount(advancedParams.capitalGains);
  const capitalLosses = normalizeAmount(advancedParams.capitalLosses);
  const donations = normalizeAmount(advancedParams.donations);
  const otherIncome = normalizeAmount(advancedParams.otherIncome);
  const otherDeductions = normalizeAmount(advancedParams.otherDeductions);
  const unionDues = normalizeAmount(advancedParams.unionDues);

  const grossUpEligible = eligibleDividends * DIVIDEND_GROSS_UP.eligible;
  const grossUpNonEligible = nonEligibleDividends * DIVIDEND_GROSS_UP.nonEligible;
  const netCapitalGains = Math.max(0, capitalGains - capitalLosses);
  const capitalGainsTaxable = netCapitalGains * CAPITAL_GAINS_INCLUSION;
  const rrsp = normalizeAmount(advancedParams.rrsp || baseParams.rrsp);

  const adjustedTaxable = Math.max(
    0,
    baseResult.taxable_pre + otherIncome + grossUpEligible + grossUpNonEligible + capitalGainsTaxable - rrsp - otherDeductions - unionDues
  );

  const { total: taxBeforeCredits, fedLow, provLow } = computeIncomeTaxWithCredits({
    taxable: adjustedTaxable,
    year: baseParams.year,
    province: baseParams.province,
    cpp: baseResult.cpp_full,
    ei: baseResult.ei_full
  });

  const donationCredit = donations * (fedLow + provLow);
  const taxAfterCredits = Math.max(0, taxBeforeCredits - donationCredit);
  const returnEstimate = +(baseResult.annualized_withholding_tax - taxAfterCredits).toFixed(2);

  return {
    eligibleDividends,
    nonEligibleDividends,
    capitalGains,
    capitalLosses,
    netCapitalGains,
    donations,
    otherIncome,
    otherDeductions,
    grossUpEligible,
    grossUpNonEligible,
    dividendGrossUp: grossUpEligible + grossUpNonEligible,
    capitalGainsTaxable,
    adjustedTaxable,
    taxBeforeCredits,
    donationCredit,
    taxAfterCredits,
    withholding: baseResult.annualized_withholding_tax,
    returnEstimate,
    unionDues,
    rrsp
  };
}

function renderAdvancedTaxReturn({ baseParams, baseResult, advancedResult, isModern }){
  const out = document.getElementById(isModern ? 'modern-adv-out' : 'adv-out');
  if (!out) return;
  const metricHTML = isModern ? `
    <div class="metric-grid">
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Advanced tax return', INFO_COPY.advanced.returnEstimate)}</div><div class="metric-value">${money(advancedResult.returnEstimate)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Adjusted taxable', INFO_COPY.advanced.adjustedTaxable)}</div><div class="metric-value">${money(advancedResult.adjustedTaxable)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Tax liability', INFO_COPY.advanced.taxLiability)}</div><div class="metric-value">${money(advancedResult.taxAfterCredits)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Withholding', INFO_COPY.advanced.withholding)}</div><div class="metric-value">${money(advancedResult.withholding)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Donation credit', INFO_COPY.advanced.donationCredit)}</div><div class="metric-value">${money(advancedResult.donationCredit)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Dividend gross-up', INFO_COPY.advanced.dividendGrossUp)}</div><div class="metric-value">${money(advancedResult.dividendGrossUp)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Taxable capital gains', INFO_COPY.advanced.capitalGainsTaxable)}</div><div class="metric-value">${money(advancedResult.capitalGainsTaxable)}</div></div>
    </div>`
    : `
    <div class="simple">
      <div class="block"><div class="label">${labelWithInfo('Advanced tax return', INFO_COPY.advanced.returnEstimate)}</div><div class="value">${money(advancedResult.returnEstimate)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Adjusted taxable', INFO_COPY.advanced.adjustedTaxable)}</div><div class="value">${money(advancedResult.adjustedTaxable)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Tax liability', INFO_COPY.advanced.taxLiability)}</div><div class="value">${money(advancedResult.taxAfterCredits)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Withholding', INFO_COPY.advanced.withholding)}</div><div class="value">${money(advancedResult.withholding)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Donation credit', INFO_COPY.advanced.donationCredit)}</div><div class="value">${money(advancedResult.donationCredit)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Dividend gross-up', INFO_COPY.advanced.dividendGrossUp)}</div><div class="value">${money(advancedResult.dividendGrossUp)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Taxable capital gains', INFO_COPY.advanced.capitalGainsTaxable)}</div><div class="value">${money(advancedResult.capitalGainsTaxable)}</div></div>
    </div>`;

  const auditRows = [
    ['Seat', baseParams.seat],
    ['Aircraft', baseParams.ac],
    ['Year', baseParams.year],
    ['Step (Jan 1)', baseParams.stepInput],
    ['Province/Territory', baseParams.province],
    ['Avg monthly credit hours', baseParams.avgMonthlyHours],
    ['RRSP contributions', money(advancedResult.rrsp)],
    ['Annual gross', money(baseResult.gross)],
    ['Annual pension', money(baseResult.pension)],
    ['Base taxable', money(baseResult.taxable_pre)],
    ['CPP/QPP (annual)', money(baseResult.cpp_full)],
    ['EI (annual)', money(baseResult.ei_full)],
    ['Withholding tax', money(baseResult.annualized_withholding_tax)],
    ['Union dues', money(advancedResult.unionDues)],
    ['Eligible dividends', money(advancedResult.eligibleDividends)],
    ['Non-eligible dividends', money(advancedResult.nonEligibleDividends)],
    ['Capital gains', money(advancedResult.capitalGains)],
    ['Capital losses', money(advancedResult.capitalLosses)],
    ['Donations', money(advancedResult.donations)],
    ['Other income', money(advancedResult.otherIncome)],
    ['Other deductions', money(advancedResult.otherDeductions)]
  ].map(([label, value]) => `<tr><td>${escapeHtml(String(label))}</td><td class="num">${escapeHtml(String(value))}</td></tr>`).join('');

  const auditHTML = `
    <details class="drawer"><summary>Audit data</summary>
      <table>
        <thead><tr><th>Item</th><th class="num">Value</th></tr></thead>
        <tbody>${auditRows}</tbody>
      </table>
    </details>`;

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const chequeRows = (baseResult.withholding_audit || []).map((entry) => {
    const monthLabel = monthNames[entry.month - 1] || entry.month;
    return `<tr><td class="num">${entry.cheque}</td><td>${escapeHtml(String(monthLabel))}</td><td class="num">${entry.step}</td><td>${escapeHtml(entry.type)}</td><td class="num">${money(entry.gross)}</td><td class="num">${money(entry.pension)}</td><td class="num">${money(entry.tax)}</td></tr>`;
  }).join('');

  const advancedAuditHTML = `
    <details class="drawer"><summary>Advanced Audit</summary>
      <table>
        <thead><tr><th class="num">Cheque</th><th>Month</th><th class="num">Step</th><th>Type</th><th class="num">Gross</th><th class="num">Pension</th><th class="num">Tax</th></tr></thead>
        <tbody>${chequeRows}</tbody>
      </table>
    </details>`;

  out.innerHTML = metricHTML + auditHTML + advancedAuditHTML;
}

function bindAdvancedReturnTriggers(container){
  if (!container) return;
  container.querySelectorAll('[data-advanced-target]').forEach((btn) => {
    addTapListener(btn, () => {
      const target = btn.getAttribute('data-advanced-target');
      openAdvancedTaxTab(target === 'modern');
    });
  });
}

function renderAnnualModern(res, params){
  const out = document.getElementById('modern-out');
  if (!out) return;
  const hourly = res.audit && res.audit.length ? res.audit[0].hourly : 0;
  const unionAnnual = (res.monthly?.union_dues || 0) * 12;
  const metricHTML = `
    <div class="metric-grid">
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Annual Gross', INFO_COPY.annual.annualGross)}</div><div class="metric-value">${money(res.gross)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Annual Net', INFO_COPY.annual.annualNet)}</div><div class="metric-value">${money(res.net)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Monthly Net', INFO_COPY.annual.monthlyNet)}</div><div class="metric-value">${money(res.monthly.net)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Hourly rate', INFO_COPY.annual.hourlyRate)}</div><div class="metric-value">${money(hourly)}</div></div>
    </div>`;

  const deductions = `
    <details class="drawer"><summary>See taxes & deductions</summary>
      <div class="metric-grid">
        <button class="metric-card actionable" type="button" data-advanced-target="modern"><div class="metric-label">${labelWithInfo('Tax Return (est.)', INFO_COPY.annual.taxReturn)}</div><div class="metric-value">${money(res.tax_return)}</div></button>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Income Tax', INFO_COPY.annual.incomeTax)}</div><div class="metric-value">${money(res.tax)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('CPP/QPP', INFO_COPY.annual.cpp)}</div><div class="metric-value">${money(res.cpp)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('EI', INFO_COPY.annual.ei)}</div><div class="metric-value">${money(res.ei)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Pension', INFO_COPY.annual.pension)}</div><div class="metric-value">${money(res.pension)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Union dues', INFO_COPY.annual.union)}</div><div class="metric-value">${money(unionAnnual)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Health', INFO_COPY.annual.health)}</div><div class="metric-value">${money(res.health)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('ESOP', INFO_COPY.annual.esopContribution)}</div><div class="metric-value">${money(res.esop)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('ESOP match (after tax)', INFO_COPY.annual.esopMatch)}</div><div class="metric-value">${money(res.esop_match_after_tax)}</div></div>
      </div>
    </details>`;

  const auditRows = (res.audit||[]).map(seg=>{
    const fmt = d => d.toISOString().slice(0,10);
    return `<tr><td>${fmt(seg.start)}</td><td>${fmt(seg.end)}</td><td>${seg.pay_table_year}</td><td>${seg.step}</td><td class="num">$${seg.hourly.toFixed(2)}</td><td class="num">${seg.hours.toFixed(2)}</td><td class="num">$${seg.segment_gross.toFixed(2)}</td></tr>`;
  }).join('');
  const auditHTML = `
    <details class="drawer"><summary>Audit timeline</summary>
      <table>
        <thead><tr><th>Start</th><th>End</th><th>Tbl Yr</th><th>Step</th><th>Hourly</th><th>Hours</th><th>Gross</th></tr></thead>
        <tbody>${auditRows}</tbody>
      </table>
    </details>`;

  out.innerHTML = metricHTML + deductions + auditHTML;
  bindAdvancedReturnTriggers(out);
}

function renderMonthlyModern(res){
  const out = document.getElementById('modern-mon-out');
  if (!out) return;
  const metricHTML = `
    <div class="metric-grid">
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Gross', INFO_COPY.monthly.gross)}</div><div class="metric-value">${money(res.gross)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Net', INFO_COPY.monthly.net)}</div><div class="metric-value">${money(res.net)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Pay advance', INFO_COPY.monthly.payAdvance)}</div><div class="metric-value">${money(res.pay_advance)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Second pay', INFO_COPY.monthly.secondPay)}</div><div class="metric-value">${money(res.second_pay)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Hourly rate', INFO_COPY.monthly.hourlyRate)}</div><div class="metric-value">${money(res.rate)}</div></div>
    </div>`;

  const deductions = `
    <details class="drawer"><summary>Show deductions</summary>
      <div class="metric-grid">
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Income Tax', INFO_COPY.monthly.incomeTax)}</div><div class="metric-value">${money(res.tax)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('CPP/QPP', INFO_COPY.monthly.cpp)}</div><div class="metric-value">${money(res.cpp)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('EI', INFO_COPY.monthly.ei)}</div><div class="metric-value">${money(res.ei)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Pension', INFO_COPY.monthly.pension)}</div><div class="metric-value">${money(res.pension)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Union dues', INFO_COPY.monthly.union)}</div><div class="metric-value">${money(res.union)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Health', INFO_COPY.monthly.health)}</div><div class="metric-value">${money(res.health)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('ESOP', INFO_COPY.monthly.esop)}</div><div class="metric-value">${money(res.esop)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('ESOP match (after tax)', INFO_COPY.monthly.esopMatch)}</div><div class="metric-value">${money(res.esop_match_after_tax)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('TAFB', INFO_COPY.monthly.tafb)}</div><div class="metric-value">${money(res.tafb_net)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Marginal FED', INFO_COPY.monthly.marginalFed)}</div><div class="metric-value">${(100*res.fed_m).toFixed(1)}%</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Marginal PROV', INFO_COPY.monthly.marginalProv)}</div><div class="metric-value">${(100*res.prov_m).toFixed(1)}%</div></div>
      </div>
    </details>`;

  const split = `
    <details class="drawer"><summary>Paycheque split details</summary>
      <div class="metric-grid">
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Credits', INFO_COPY.monthly.credits)}</div><div class="metric-value">${res.credits.toFixed(2)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('VO credits', INFO_COPY.monthly.voCredits)}</div><div class="metric-value">${res.voCredits.toFixed(2)}</div></div>
      </div>
    </details>`;

  out.innerHTML = metricHTML + deductions + split;
}

function renderVOModern(res){
  const out = document.getElementById('modern-ot-out');
  if (!out) return;
  const metricHTML = `
    <div class="metric-grid">
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Gross', INFO_COPY.vo.gross)}</div><div class="metric-value">${money(res.gross)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Net', INFO_COPY.vo.net)}</div><div class="metric-value">${money(res.net)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Hourly', INFO_COPY.vo.hourlyRate)}</div><div class="metric-value">${money(res.rate)}</div></div>
      <div class="metric-card"><div class="metric-label">${labelWithInfo('Hours (Credit×2)', INFO_COPY.vo.hours)}</div><div class="metric-value">${res.hours.toFixed(2)}</div></div>
    </div>`;
  const detail = `
    <details class="drawer"><summary>Tax rates</summary>
      <div class="metric-grid">
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Marginal FED', INFO_COPY.vo.marginalFed)}</div><div class="metric-value">${(100*res.fed_m).toFixed(1)}%</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Marginal PROV', INFO_COPY.vo.marginalProv)}</div><div class="metric-value">${(100*res.prov_m).toFixed(1)}%</div></div>
      </div>
    </details>`;
  out.innerHTML = metricHTML + detail;
}

function renderAnnual(res, params){
  const out = document.getElementById('out');
  const simpleHTML = `
    <div class="simple">
      <div class="block"><div class="label">${labelWithInfo('Annual Net', INFO_COPY.annual.annualNet)}</div><div class="value">${money(res.net)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Annual Gross', INFO_COPY.annual.annualGross)}</div><div class="value">${money(res.gross)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Monthly Gross', INFO_COPY.annual.monthlyGross)}</div><div class="value">${money(res.monthly.gross)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Monthly Net', INFO_COPY.annual.monthlyNet)}</div><div class="value">${money(res.monthly.net)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Income Tax', INFO_COPY.annual.incomeTax)}</div><div class="value">${money(res.tax)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('CPP/QPP', INFO_COPY.annual.cpp)}</div><div class="value">${money(res.cpp)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('EI', INFO_COPY.annual.ei)}</div><div class="value">${money(res.ei)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Pension', INFO_COPY.annual.pension)}</div><div class="value">${money(res.pension)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('ESOP Contributions', INFO_COPY.annual.esopContribution)}</div><div class="value">${money(res.esop)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('ESOP match (after tax)', INFO_COPY.annual.esopMatch)}</div><div class="value">${money(res.esop_match_after_tax)}</div></div>
    </div>`;
  const taxHTML = `
    <details class="drawer"><summary>Tax return</summary>
      <div class="simple">
        <button class="block actionable" type="button" data-advanced-target="legacy"><div class="label">${labelWithInfo('Tax Return', INFO_COPY.annual.taxReturn)}</div><div class="value">${money(res.tax_return)}</div></button>
      </div>
    </details>`;
  const auditRows = res.audit.map(seg=>{
    const fmt = d => d.toISOString().slice(0,10);
    return `<tr>
      <td>${fmt(seg.start)}</td>
      <td>${fmt(seg.end)}</td>
      <td>${seg.pay_table_year}</td>
      <td>${seg.step}</td>
      <td class="num">$${seg.hourly.toFixed(2)}</td>
      <td class="num">${seg.hours.toFixed(2)}</td>
      <td class="num">$${seg.segment_gross.toFixed(2)}</td>
    </tr>`;
  }).join('');
  const auditHTML = `
    <div class="sectionTitle">Audit (date ranges)</div>
    <div class="auditwrap">
      <table class="audit">
        <thead>
          <tr>
            <th>Start</th><th>End</th><th>Tbl Yr</th><th>Step</th><th>Hourly</th><th>Hours</th><th>Gross</th>
          </tr>
        </thead>
        <tbody>${auditRows}</tbody>
      </table>
    </div>`;
  out.innerHTML = simpleHTML + taxHTML + auditHTML;
  bindAdvancedReturnTriggers(out);
}
function renderVO(res, params){
  const out = document.getElementById('ot-out');
  const statsHTML = `
    <div class="simple">
      <div class="block"><div class="label">${labelWithInfo('Hourly Rate', INFO_COPY.vo.hourlyRate)}</div><div class="value">${money(res.rate)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Hours (Credit×2)', INFO_COPY.vo.hours)}</div><div class="value">${res.hours.toFixed(2)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Gross', INFO_COPY.vo.gross)}</div><div class="value">${money(res.gross)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Net', INFO_COPY.vo.net)}</div><div class="value">${money(res.net)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Marginal FED', INFO_COPY.vo.marginalFed)}</div><div class="value">${(100*res.fed_m).toFixed(1)}%</div></div>
      <div class="block"><div class="label">${labelWithInfo('Marginal PROV', INFO_COPY.vo.marginalProv)}</div><div class="value">${(100*res.prov_m).toFixed(1)}%</div></div>
    </div>`;
  out.innerHTML = statsHTML;
}
function renderMonthly(res, params){
  const out = document.getElementById('mon-out');
  const statsHTML = `
    <div class="simple">
      <div class="block"><div class="label">${labelWithInfo('Hourly Rate', INFO_COPY.monthly.hourlyRate)}</div><div class="value">${money(res.rate)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Credits', INFO_COPY.monthly.credits)}</div><div class="value">${res.credits.toFixed(2)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('VO Credits', INFO_COPY.monthly.voCredits)}</div><div class="value">${res.voCredits.toFixed(2)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Gross', INFO_COPY.monthly.gross)}</div><div class="value">${money(res.gross)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Net', INFO_COPY.monthly.net)}</div><div class="value">${money(res.net)}</div></div>
      <div class="block" style="margin-left:16px"><div class="label">${labelWithInfo('Pay Advance', INFO_COPY.monthly.payAdvance)}</div><div class="value">${money(res.pay_advance)}</div></div>
      <div class="block" style="margin-left:16px"><div class="label">${labelWithInfo('Second Pay', INFO_COPY.monthly.secondPay)}</div><div class="value">${money(res.second_pay)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Income Tax', INFO_COPY.monthly.incomeTax)}</div><div class="value">${money(res.tax)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('CPP/QPP', INFO_COPY.monthly.cpp)}</div><div class="value">${money(res.cpp)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('EI', INFO_COPY.monthly.ei)}</div><div class="value">${money(res.ei)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Pension', INFO_COPY.monthly.pension)}</div><div class="value">${money(res.pension)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Health', INFO_COPY.monthly.health)}</div><div class="value">${money(res.health)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('ESOP', INFO_COPY.monthly.esop)}</div><div class="value">${money(res.esop)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('ESOP match (after tax)', INFO_COPY.monthly.esopMatch)}</div><div class="value">${money(res.esop_match_after_tax)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Union Dues', INFO_COPY.monthly.union)}</div><div class="value">${money(res.union)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('TAFB (after tax)', INFO_COPY.monthly.tafb)}</div><div class="value">${money(res.tafb_net)}</div></div>
      <div class="block"><div class="label">${labelWithInfo('Marginal FED', INFO_COPY.monthly.marginalFed)}</div><div class="value">${(100*res.fed_m).toFixed(1)}%</div></div>
      <div class="block"><div class="label">${labelWithInfo('Marginal PROV', INFO_COPY.monthly.marginalProv)}</div><div class="value">${(100*res.prov_m).toFixed(1)}%</div></div>
    </div>`;
  out.innerHTML = statsHTML;
}

function renderDutyResult(outEl, result, isModern){
  if (!outEl) return;
  if (!result || result.maxFdp === null){
    const message = result?.detail || 'Unable to determine max FDP.';
    outEl.innerHTML = `<div class="simple"><div class="block"><div class="label">Notice</div><div class="value">${escapeHtml(message)}</div></div></div>`;
    return;
  }
  const maxText = formatHoursMinutes(result.maxFdp);
  const detailText = escapeHtml(result.detail);
  const endUtcText = result.endUtc ? escapeHtml(result.endUtc) : null;
  const brakesSetText = result.brakesSetUtc ? escapeHtml(result.brakesSetUtc) : null;
  if (isModern){
    outEl.innerHTML = `
      <div class="metric-grid">
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Maximum FDP', INFO_COPY.duty.maxFdp)}</div><div class="metric-value">${maxText}</div></div>
        ${endUtcText ? `<div class="metric-card"><div class="metric-label">${labelWithInfo('FDP end (UTC)', INFO_COPY.duty.endUtc)}</div><div class="metric-value">${endUtcText}</div><button class="convert-btn" type="button" data-utc-time="${endUtcText}" data-ui="modern">Convert</button></div>` : ''}
        ${brakesSetText ? `<div class="metric-card"><div class="metric-label">${labelWithInfo('Brakes set (UTC)', INFO_COPY.duty.brakesSet)}</div><div class="metric-value">${brakesSetText}</div><button class="convert-btn" type="button" data-utc-time="${brakesSetText}" data-ui="modern">Convert</button></div>` : ''}
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Rule basis', INFO_COPY.duty.basis)}</div><div class="metric-value" style="font-size:14px">${detailText}</div></div>
      </div>`;
  } else {
    outEl.innerHTML = `
      <div class="simple">
        <div class="block"><div class="label">${labelWithInfo('Maximum FDP', INFO_COPY.duty.maxFdp)}</div><div class="value">${maxText}</div></div>
        ${endUtcText ? `<div class="block"><div class="label">${labelWithInfo('FDP end (UTC)', INFO_COPY.duty.endUtc)}</div><div class="value">${endUtcText}</div><button class="convert-btn" type="button" data-utc-time="${endUtcText}" data-ui="legacy">Convert</button></div>` : ''}
        ${brakesSetText ? `<div class="block"><div class="label">${labelWithInfo('Brakes set (UTC)', INFO_COPY.duty.brakesSet)}</div><div class="value">${brakesSetText}</div><button class="convert-btn" type="button" data-utc-time="${brakesSetText}" data-ui="legacy">Convert</button></div>` : ''}
        <div class="block"><div class="label">${labelWithInfo('Rule basis', INFO_COPY.duty.basis)}</div><div class="value" style="font-size:14px">${detailText}</div></div>
      </div>`;
  }
  const convertButtons = outEl.querySelectorAll('.convert-btn');
  convertButtons.forEach((convertBtn) => {
    addTapListener(convertBtn, (e) => {
      hapticTap(e.currentTarget);
      const utcTime = convertBtn.getAttribute('data-utc-time') || '';
      const ui = convertBtn.getAttribute('data-ui') || 'legacy';
      convertFdpEndToTimeConverter(utcTime, ui === 'modern');
    });
  });
}

function renderRestResult(outEl, result, isModern){
  if (!outEl) return;
  const notes = result.notes || [];
  const notesHtml = notes.length
    ? `<ul class="note-list">${notes.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`
    : '<div class="muted-note">No additional rest adjustments required.</div>';
  if (isModern){
    outEl.innerHTML = `
      <div class="metric-grid">
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Minimum rest', INFO_COPY.rest.minimum)}</div><div class="metric-value">${escapeHtml(result.minimumText)}</div></div>
        <div class="metric-card"><div class="metric-label">${labelWithInfo('Rule basis', INFO_COPY.rest.basis)}</div><div class="metric-value" style="font-size:14px">${escapeHtml(result.basis)}</div></div>
      </div>
      <div class="sectionTitle">${labelWithInfo('Additional requirements', INFO_COPY.rest.extras)}</div>
      ${notesHtml}`;
  } else {
    outEl.innerHTML = `
      <div class="simple">
        <div class="block"><div class="label">${labelWithInfo('Minimum rest', INFO_COPY.rest.minimum)}</div><div class="value">${escapeHtml(result.minimumText)}</div></div>
        <div class="block"><div class="label">${labelWithInfo('Rule basis', INFO_COPY.rest.basis)}</div><div class="value" style="font-size:14px">${escapeHtml(result.basis)}</div></div>
      </div>
      <div class="sectionTitle">${labelWithInfo('Additional requirements', INFO_COPY.rest.extras)}</div>
      ${notesHtml}`;
  }
}

// --- Actions ---
function calcAnnual(){
  try{
    const params = getAnnualParams(false);
    const res = computeAnnual(params);
    renderAnnual(res, params);
  } catch(err){
    document.getElementById('out').innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}
function calcVO(){
  try{
    const params = {
      seat: document.getElementById('ot-seat').value,
      ac: document.getElementById('ot-ac').value,
      year: +document.getElementById('ot-year').value,
      stepInput: +document.getElementById('ot-step').value,
      tieOn: document.getElementById('ot-tie').checked,
      xlrOn: document.getElementById('ot-xlr').checked,
      province: document.getElementById('ot-prov').value,
      creditH: +document.getElementById('ot-cred-h').value,
      creditM: +document.getElementById('ot-cred-m').value
    };
    const res = computeVO(params);
    renderVO(res, params);
  } catch(err){
    document.getElementById('ot-out').innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}
function calcMonthly(){
  try{
    const params = {
      seat: document.getElementById('mon-seat').value,
      ac: document.getElementById('mon-ac').value,
      year: +document.getElementById('mon-year').value,
      stepInput: +document.getElementById('mon-step').value,
      tieOn: document.getElementById('mon-tie').checked,
      xlrOn: document.getElementById('mon-xlr').checked,
      province: document.getElementById('mon-prov').value,
      creditH: +document.getElementById('mon-hrs').value,
      creditM: +document.getElementById('mon-mins').value,
      voCredits: +document.getElementById('mon-vo').value,
      voCreditMinutes: +(document.getElementById('mon-vo-mins')?.value || 0),
      tafb: +document.getElementById('mon-tafb').value,
      esopPct: +document.getElementById('mon-esop').value,
      adv: +document.getElementById('mon-adv').value,
      maxcpp: document.getElementById('mon-maxcpp').checked
    };
    const res = computeMonthly(params);
    renderMonthly(res, params);
  } catch(err){
    document.getElementById('mon-out').innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}

async function calcDutyLegacy(){
  try{
    const dutyType = document.getElementById('duty-type')?.value;
    const zone = document.getElementById('duty-zone')?.value;
    const dutyMode = document.getElementById('duty-mode')?.value;
    const params = {
      dutyType,
      zone,
      dutyMode,
      sectors: document.getElementById('duty-sectors')?.value,
      crewType: document.getElementById('duty-crew')?.value,
      restFacility: document.getElementById('duty-rest-facility')?.value,
      deadhead: document.getElementById('duty-deadhead')?.value
    };
    if (dutyType === 'unaugmented'){
      const startTime = document.getElementById('duty-start')?.value;
      const departureCode = document.getElementById('duty-departure')?.value;
      if (dutyMode === 'fom'){
        const conversion = await computeFdpStartInYYZ(startTime, departureCode);
        params.startTime = startTime;
        params.startUtcMinutes = conversion.startUtcMinutes;
      } else {
        const arrivalCode = document.getElementById('duty-arrival')?.value;
        const conversion = await computeFdpStartInYYZ(startTime, departureCode);
        const timezoneDiff = await computeTimezoneDiffBetweenAirports(departureCode, arrivalCode);
        params.startMinutes = conversion.startMinutes;
        params.startUtcMinutes = conversion.startUtcMinutes;
        params.timezoneDiff = timezoneDiff;
        params.conversionNote = `Departure ${conversion.departure} local ${conversion.localLabel} → ${conversion.yyzLabel} YYZ. Arrival ${normalizeAirportCode(arrivalCode)} (${formatHoursValue(timezoneDiff)}h time zone difference).`;
      }
    }
    const res = computeMaxDuty(params);
    if (Number.isFinite(res.maxFdp) && Number.isFinite(params.startUtcMinutes)){
      const endUtcMinutes = params.startUtcMinutes + (res.maxFdp * 60);
      res.endUtc = formatUtcMinutesWithDayOffset(endUtcMinutes);
      if (dutyMode !== 'fom'){
        res.brakesSetUtc = formatUtcMinutesWithDayOffset(endUtcMinutes - 15);
      }
    }
    renderDutyResult(document.getElementById('duty-out'), res, false);
  } catch(err){
    const out = document.getElementById('duty-out');
    if (out) out.innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}

async function calcDutyModern(){
  try{
    const dutyType = document.getElementById('modern-duty-type')?.value;
    const zone = document.getElementById('modern-duty-zone')?.value;
    const dutyMode = document.getElementById('modern-duty-mode')?.value;
    const params = {
      dutyType,
      zone,
      dutyMode,
      sectors: document.getElementById('modern-duty-sectors')?.value,
      crewType: document.getElementById('modern-duty-crew')?.value,
      restFacility: document.getElementById('modern-duty-rest-facility')?.value,
      deadhead: document.getElementById('modern-duty-deadhead')?.value
    };
    if (dutyType === 'unaugmented'){
      const startTime = document.getElementById('modern-duty-start')?.value;
      const departureCode = document.getElementById('modern-duty-departure')?.value;
      if (dutyMode === 'fom'){
        const conversion = await computeFdpStartInYYZ(startTime, departureCode);
        params.startTime = startTime;
        params.startUtcMinutes = conversion.startUtcMinutes;
      } else {
        const arrivalCode = document.getElementById('modern-duty-arrival')?.value;
        const conversion = await computeFdpStartInYYZ(startTime, departureCode);
        const timezoneDiff = await computeTimezoneDiffBetweenAirports(departureCode, arrivalCode);
        params.startMinutes = conversion.startMinutes;
        params.startUtcMinutes = conversion.startUtcMinutes;
        params.timezoneDiff = timezoneDiff;
        params.conversionNote = `Departure ${conversion.departure} local ${conversion.localLabel} → ${conversion.yyzLabel} YYZ. Arrival ${normalizeAirportCode(arrivalCode)} (${formatHoursValue(timezoneDiff)}h time zone difference).`;
      }
    }
    const res = computeMaxDuty(params);
    if (Number.isFinite(res.maxFdp) && Number.isFinite(params.startUtcMinutes)){
      const endUtcMinutes = params.startUtcMinutes + (res.maxFdp * 60);
      res.endUtc = formatUtcMinutesWithDayOffset(endUtcMinutes);
      if (dutyMode !== 'fom'){
        res.brakesSetUtc = formatUtcMinutesWithDayOffset(endUtcMinutes - 15);
      }
    }
    renderDutyResult(document.getElementById('modern-duty-out'), res, true);
  } catch(err){
    const out = document.getElementById('modern-duty-out');
    if (out) out.innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}

async function calcRestLegacy(){
  const out = document.getElementById('rest-out');
  try{
    const dutyType = document.getElementById('rest-duty-type')?.value;
    const layoverCode = document.getElementById('rest-layover-location')?.value;
    const endsHome = isHomeBaseCode(layoverCode) ? 'home' : 'away';
    const timezoneDiff = endsHome === 'home'
      ? 0
      : await computeTimezoneDiffFromYYZ(layoverCode);
    const params = {
      dutyType,
      fdpDuration: document.getElementById('rest-fdp-duration')?.value,
      endsHome,
      timezoneDiff,
      awayHours: document.getElementById('rest-away-hours')?.value,
      encroachWOCL: document.getElementById('rest-encroach')?.value,
      disruptive: document.getElementById('rest-disruptive')?.value,
      uocOver: document.getElementById('rest-uoc')?.value
    };
    const res = computeRestRequirement(params);
    renderRestResult(out, res, false);
  } catch(err){
    if (out) out.innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}

async function calcRestModern(){
  const out = document.getElementById('modern-rest-out');
  try{
    const dutyType = document.getElementById('modern-rest-duty-type')?.value;
    const layoverCode = document.getElementById('modern-rest-layover-location')?.value;
    const endsHome = isHomeBaseCode(layoverCode) ? 'home' : 'away';
    const timezoneDiff = endsHome === 'home'
      ? 0
      : await computeTimezoneDiffFromYYZ(layoverCode);
    const params = {
      dutyType,
      fdpDuration: document.getElementById('modern-rest-fdp-duration')?.value,
      endsHome,
      timezoneDiff,
      awayHours: document.getElementById('modern-rest-away-hours')?.value,
      encroachWOCL: document.getElementById('modern-rest-encroach')?.value,
      disruptive: document.getElementById('modern-rest-disruptive')?.value,
      uocOver: document.getElementById('modern-rest-uoc')?.value
    };
    const res = computeRestRequirement(params);
    renderRestResult(out, res, true);
  } catch(err){
    if (out) out.innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}

function calcAnnualModern(){
  try{
    const params = getAnnualParams(true);
    const res = computeAnnual(params);
    renderAnnualModern(res, params);
    syncAdvancedUnionDues(true, res);
  } catch(err){
    const out = document.getElementById('modern-out');
    if (out) out.innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}

function calcAdvancedReturn(isModern){
  try{
    const baseParams = getAnnualParams(isModern);
    const baseResult = computeAnnual(baseParams);
    syncAdvancedUnionDues(isModern, baseResult);
    const advancedParams = getAdvancedInputs(isModern);
    const advancedResult = computeAdvancedTaxReturn({ baseParams, baseResult, advancedParams });
    renderAdvancedTaxReturn({ baseParams, baseResult, advancedResult, isModern });
  } catch(err){
    const out = document.getElementById(isModern ? 'modern-adv-out' : 'adv-out');
    if (out) out.innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}

function openAdvancedTaxTab(isModern){
  syncAdvancedRrsp(isModern);
  if (isModern){
    setModernSubTab('modern-annual-advanced');
  } else {
    setLegacySubTab('annual-advanced');
  }
  calcAdvancedReturn(isModern);
}

function calcMonthlyModern(){
  try{
    const params = {
      seat: document.getElementById('modern-mon-seat').value,
      ac: document.getElementById('modern-mon-ac').value,
      year: +document.getElementById('modern-mon-year').value,
      stepInput: +document.getElementById('modern-mon-step').value,
      tieOn: document.getElementById('modern-mon-tie').checked,
      xlrOn: document.getElementById('modern-mon-xlr').checked,
      province: document.getElementById('modern-mon-prov').value,
      creditH: +document.getElementById('modern-mon-hrs').value,
      creditM: +document.getElementById('modern-mon-mins').value,
      voCredits: +document.getElementById('modern-mon-vo').value,
      voCreditMinutes: +document.getElementById('modern-mon-vo-mins').value,
      tafb: +document.getElementById('modern-mon-tafb').value,
      esopPct: +document.getElementById('modern-mon-esop').value,
      adv: +document.getElementById('modern-mon-adv').value,
      maxcpp: document.getElementById('modern-mon-maxcpp').checked
    };
    const res = computeMonthly(params);
    renderMonthlyModern(res, params);
  } catch(err){
    const out = document.getElementById('modern-mon-out');
    if (out) out.innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}

function calcVOModern(){
  try{
    const params = {
      seat: document.getElementById('modern-ot-seat').value,
      ac: document.getElementById('modern-ot-ac').value,
      year: +document.getElementById('modern-ot-year').value,
      stepInput: +document.getElementById('modern-ot-step').value,
      tieOn: document.getElementById('modern-ot-tie').checked,
      xlrOn: document.getElementById('modern-ot-xlr').checked,
      province: document.getElementById('modern-ot-prov').value,
      creditH: +document.getElementById('modern-ot-cred-h').value,
      creditM: +document.getElementById('modern-ot-cred-m').value
    };
    const res = computeVO(params);
    renderVOModern(res, params);
  } catch(err){
    const out = document.getElementById('modern-ot-out');
    if (out) out.innerHTML = '<div class="simple"><div class="block"><div class="label">Error</div><div class="value">'+String(err.message)+'</div></div></div>';
    console.error(err);
  }
}

// --- Init ---
function autoSelectDefaults() {
  try {
    const now = new Date();
    // Determine pay year: dates on/after Oct 1 use the current year, else previous year.
    const rollover = new Date(now.getFullYear(), SWITCH.m - 1, SWITCH.d);
    let payYear = now.getFullYear();
    if (now < rollover) {
      payYear = now.getFullYear() - 1;
    }
    // Determine current step: first eligible progression date is one year after hire.
    const hireDate = DOH;
    const threshold = new Date(hireDate.getFullYear() + 1, hireDate.getMonth(), hireDate.getDate());
    let step = 1;
    let y = threshold.getFullYear();
    while (true) {
      const stepDate = new Date(y, PROGRESSION.m - 1, PROGRESSION.d);
      if (stepDate >= threshold && stepDate <= now) {
        step++;
        y++;
      } else {
        break;
      }
    }
    if (step > 12) step = 12;
    // Apply to dropdowns; include Monthly tab
    const ids = ['year','step','ot-year','ot-step','mon-year','mon-step','modern-year','modern-step','modern-ot-year','modern-ot-step','modern-mon-year','modern-mon-step'];
    const vals = [payYear, step, payYear, step, payYear, step, payYear, step, payYear, step, payYear, step];
    ids.forEach((id, idx) => {
      const el = document.getElementById(id);
      if (!el) return;
      for (let i = 0; i < el.options.length; i++) {
        if (String(el.options[i].value) === String(vals[idx])) {
          el.selectedIndex = i;
          el.dispatchEvent(new Event('change'));
          break;
        }
      }
    });
  } catch (e) {
    console.error('autoSelectDefaults error:', e);
  }
}

function startUtcClock(ids) {
  const targets = ids.map(id => document.getElementById(id)).filter(Boolean);
  if (!targets.length) return;
  const update = () => {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const month = now.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
    const ts = `Current UTC: ${hh}:${mm} ${dd} ${month}`;
    targets.forEach(el => { el.textContent = ts; });
  };
  update();
  setInterval(update, 30000);
}

function init(){
  updateVersionBadgeFromSW();
  purgeLegacyFinSyncSettings();
  startUtcClock([
    'modern-utc-clock',
    'modern-duty-utc-clock',
    'modern-rest-utc-clock'
  ]);
  setModernPrimaryTab('modern-pay');
  setModernSubTab('modern-annual');
  setModernDutyTab('modern-duty');
  addTapListener(document.getElementById('tabbtn-modern-pay'), (e)=>{ hapticTap(e.currentTarget); setModernPrimaryTab('modern-pay'); });
  addTapListener(document.getElementById('tabbtn-modern-weather'), (e)=>{ hapticTap(e.currentTarget); setModernPrimaryTab('modern-weather'); });
  addTapListener(document.getElementById('tabbtn-modern-duty-rest'), (e)=>{ hapticTap(e.currentTarget); setModernPrimaryTab('modern-duty-rest'); });
  addTapListener(document.getElementById('tabbtn-modern-calendar'), (e)=>{ hapticTap(e.currentTarget); setModernPrimaryTab('modern-calendar'); });
  addTapListener(document.getElementById('tabbtn-modern-fin'), (e)=>{ hapticTap(e.currentTarget); setModernPrimaryTab('modern-fin'); });
  addTapListener(document.getElementById('tabbtn-modern-annual'), (e)=>{ hapticTap(e.currentTarget); setModernSubTab('modern-annual'); });
  addTapListener(document.getElementById('tabbtn-modern-monthly'), (e)=>{ hapticTap(e.currentTarget); setModernSubTab('modern-monthly'); });
  addTapListener(document.getElementById('tabbtn-modern-vo'), (e)=>{ hapticTap(e.currentTarget); setModernSubTab('modern-vo'); });
  addTapListener(document.getElementById('tabbtn-modern-fin-qrh'), (e)=>{ hapticTap(e.currentTarget); setModernFinTab('modern-fin-qrh'); });
  addTapListener(document.getElementById('tabbtn-modern-flight-number'), (e)=>{ hapticTap(e.currentTarget); setModernFinTab('modern-flight-number'); });
  addTapListener(document.getElementById('tabbtn-modern-duty'), (e)=>{ hapticTap(e.currentTarget); setModernDutyTab('modern-duty'); });
  addTapListener(document.getElementById('tabbtn-modern-rest'), (e)=>{ hapticTap(e.currentTarget); setModernDutyTab('modern-rest'); });
  addTapListener(document.getElementById('tabbtn-modern-time-converter'), (e)=>{ hapticTap(e.currentTarget); setModernDutyTab('modern-time-converter'); });
  addTapListener(document.getElementById('tabbtn-modern-time-calculator'), (e)=>{ hapticTap(e.currentTarget); setModernDutyTab('modern-time-calculator'); });
  // Dropdown behaviors
  document.getElementById('modern-seat')?.addEventListener('change', ()=>onSeatChangeModern());
  document.getElementById('modern-ot-seat')?.addEventListener('change', ()=>onSeatChangeModernVO());
  document.getElementById('modern-mon-seat')?.addEventListener('change', ()=>onSeatChangeModernMonthly());
  document.getElementById('modern-year')?.addEventListener('change', ()=>tieYearStepFromYearModern());
  document.getElementById('modern-ot-year')?.addEventListener('change', ()=>tieYearStepFromYearModernVO());
  document.getElementById('modern-mon-year')?.addEventListener('change', ()=>tieYearStepFromYearModernMonthly());
  document.getElementById('modern-step')?.addEventListener('change', ()=>tieYearStepFromStepModern());
  document.getElementById('modern-ot-step')?.addEventListener('change', ()=>tieYearStepFromStepModernVO());
  document.getElementById('modern-mon-step')?.addEventListener('change', ()=>tieYearStepFromStepModernMonthly());
  const projectionScenarioSelect = document.getElementById('modern-projection-scenario');
  if (projectionScenarioSelect){
    projectionScenarioSelect.value = currentProjectionScenario;
    projectionScenarioSelect.addEventListener('change', () => {
      setProjectionScenario(projectionScenarioSelect.value);
    });
  }
  const projectionSlopeSelect = document.getElementById('modern-projection-slope');
  if (projectionSlopeSelect){
    projectionSlopeSelect.value = currentSlopeScenario;
    projectionSlopeSelect.addEventListener('change', () => {
      setSlopeScenario(projectionSlopeSelect.value);
    });
  }
  ['modern-year','modern-mon-year','modern-ot-year'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', updateProjectionControlsVisibility);
  });
  updateProjectionControlsVisibility();
  document.getElementById('modern-duty-type')?.addEventListener('change', ()=>toggleDutyFields('modern-duty-type','modern-duty-unaug-fields','modern-duty-aug-fields'));
  document.getElementById('modern-duty-mode')?.addEventListener('change', ()=>{ toggleDutyModeFields('modern-duty-mode','modern-duty'); updateAugmentedFacilityOptions('modern-duty-crew','modern-duty-rest-facility'); });
  document.getElementById('modern-duty-crew')?.addEventListener('change', ()=>updateAugmentedFacilityOptions('modern-duty-crew','modern-duty-rest-facility'));
  document.getElementById('modern-rest-duty-type')?.addEventListener('change', ()=>toggleRestFields('modern-rest-duty-type','modern-rest-unaug-fields'));
  // ESOP slider labels
  const newEsopEl=document.getElementById('modern-esop'); const newEsopPct=document.getElementById('modern-esopPct');
  if (newEsopEl && newEsopPct){ newEsopEl.addEventListener('input', ()=>{ newEsopPct.textContent = newEsopEl.value+'%'; }); }
  const newMonEsopEl=document.getElementById('modern-mon-esop'); const newMonEsopPct=document.getElementById('modern-mon-esopPct');
  if (newMonEsopEl && newMonEsopPct){ newMonEsopEl.addEventListener('input', ()=>{ newMonEsopPct.textContent = newMonEsopEl.value+'%'; }); }
  // Buttons
  addTapListener(document.getElementById('modern-calc'), (e)=>{ hapticTap(e.currentTarget); calcAnnualModern(); });
  addTapListener(document.getElementById('modern-adv-calc'), (e)=>{ hapticTap(e.currentTarget); calcAdvancedReturn(true); });
  addTapListener(document.getElementById('modern-adv-back'), (e)=>{ hapticTap(e.currentTarget); setModernSubTab('modern-annual'); });
  addTapListener(document.getElementById('modern-ot-calc'), (e)=>{ hapticTap(e.currentTarget); calcVOModern(); });
  addTapListener(document.getElementById('modern-mon-calc'), (e)=>{ hapticTap(e.currentTarget); calcMonthlyModern(); });
  addTapListener(document.getElementById('modern-duty-calc'), (e)=>{ hapticTap(e.currentTarget); calcDutyModern(); });
  addTapListener(document.getElementById('modern-rest-calc'), (e)=>{ hapticTap(e.currentTarget); calcRestModern(); });
  addTapListener(document.getElementById('modern-wx-run'), (e)=>{ hapticTap(e.currentTarget); runWeatherWorkflow({ depId:'modern-wx-dep', arrId:'modern-wx-arr', depHrsId:'modern-wx-dep-hrs', arrHrsId:'modern-wx-arr-hrs', outId:'modern-wx-out', rawId:'modern-wx-raw-body' }); });
  addTapListener(document.getElementById('modern-timecalc-run'), (e)=>{ hapticTap(e.currentTarget); runTimeCalculator({ startId:'modern-timecalc-start', hoursId:'modern-timecalc-hours', minutesId:'modern-timecalc-minutes', modeId:'modern-timecalc-mode', outId:'modern-timecalc-out', converterTarget:'modern' }); });
  addTapListener(document.getElementById('modern-fin-export-btn'), (e)=>{ hapticTap(e.currentTarget); exportFinConfigsToGitHub({ statusId: 'modern-fin-export-status' }); });
  addTapListener(document.getElementById('modern-fin-api-btn'), (e)=>{ hapticTap(e.currentTarget); openFinHiddenPage('api'); setModernPrimaryTab('modern-fin'); });
  addTapListener(document.getElementById('fin-hidden-back'), (e)=>{ hapticTap(e.currentTarget); closeFinHiddenPage(); setModernPrimaryTab('modern-fin'); });
  addTapListener(document.getElementById('metar-history-close'), (e)=>{ hapticTap(e.currentTarget); closeMetarHistoryPage(); });
  const metarHistoryCeiling = document.getElementById('metar-history-ceiling');
  if (metarHistoryCeiling){
    const activate = (e) => { hapticTap(e.currentTarget); handleMetarHistoryBadgeClick('ceiling'); };
    addTapListener(metarHistoryCeiling, activate);
    metarHistoryCeiling.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' '){
        ev.preventDefault();
        activate(ev);
      }
    });
  }
  const metarHistoryVisibility = document.getElementById('metar-history-visibility');
  if (metarHistoryVisibility){
    const activate = (e) => { hapticTap(e.currentTarget); handleMetarHistoryBadgeClick('visibility'); };
    addTapListener(metarHistoryVisibility, activate);
    metarHistoryVisibility.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' '){
        ev.preventDefault();
        activate(ev);
      }
    });
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape'){
      const page = document.getElementById('metar-history-page');
      if (page && !page.classList.contains('hidden')){
        closeMetarHistoryPage();
      }
    }
  });
  const finCodeSwitch = document.getElementById('fin-code-switch');
  if (finCodeSwitch){
    addTapListener(finCodeSwitch, (e) => {
      hapticTap(e.currentTarget);
      setFinAirportCodeMode(finAirportCodeMode === 'icao' ? 'iata' : 'icao');
    });
  }
  document.querySelectorAll('[data-fin-code-label]').forEach((label) => {
    addTapListener(label, (e) => {
      hapticTap(e.currentTarget);
      setFinAirportCodeMode(label.dataset.finCodeLabel === 'iata' ? 'iata' : 'icao');
    });
  });
  document.querySelectorAll('[data-flight-carrier]').forEach((btn) => {
    addTapListener(btn, (e) => {
      hapticTap(e.currentTarget);
      setFlightLookupCarrier(btn.dataset.flightCarrier);
    });
  });
  const flightLookupBtn = document.getElementById('fin-flightnumber-lookup');
  if (flightLookupBtn){
    addTapListener(flightLookupBtn, (e) => {
      hapticTap(e.currentTarget);
      const input = document.getElementById('fin-flightnumber-input');
      const callsign = buildFlightLookupCallsign(input?.value || '');
      if (!callsign){
        const statusEl = document.getElementById('fin-flightnumber-status');
        if (statusEl) statusEl.textContent = 'Enter a flight number to search.';
        clearFlightLookupResults();
        return;
      }
      loadFlightLookup(callsign);
    });
  }
  const flightLookupClear = document.getElementById('fin-flightnumber-clear');
  if (flightLookupClear){
    addTapListener(flightLookupClear, (e) => {
      hapticTap(e.currentTarget);
      const input = document.getElementById('fin-flightnumber-input');
      if (input) input.value = '';
      clearFlightLookupResults();
    });
  }
  const flightLookupInput = document.getElementById('fin-flightnumber-input');
  if (flightLookupInput){
    flightLookupInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter'){
        event.preventDefault();
        const callsign = buildFlightLookupCallsign(flightLookupInput.value);
        if (!callsign) return;
        loadFlightLookup(callsign);
      }
    });
  }
  addTapListener(document.getElementById('fr24-save'), (e)=>{ hapticTap(e.currentTarget); handleFr24ConfigSave(); });
  const heroBanner = document.getElementById('modern-hero-banner');
  if (heroBanner){
    const toggleBanner = () => {
      const isRed = heroBanner.classList.toggle('is-red');
      heroBanner.setAttribute('aria-pressed', isRed ? 'true' : 'false');
      document.body.classList.toggle('easter-red', isRed);
    };
    addTapListener(heroBanner, toggleBanner);
    heroBanner.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' '){
        e.preventDefault();
        toggleBanner();
      }
    });
  }
  // Tab defaults
  setModernPrimaryTab('modern-pay');
  setModernSubTab('modern-annual');
  setModernDutyTab('modern-duty');
  setModernFinTab(currentModernFinTab);
  // Defaults
  onSeatChangeModern();
  onSeatChangeModernVO();
  onSeatChangeModernMonthly();
  tieYearStepFromYearModern();
  tieYearStepFromYearModernVO();
  tieYearStepFromYearModernMonthly();
  tieYearStepFromStepModern();
  tieYearStepFromStepModernVO();
  tieYearStepFromStepModernMonthly();
  toggleDutyFields('modern-duty-type','modern-duty-unaug-fields','modern-duty-aug-fields');
  toggleDutyModeFields('modern-duty-mode','modern-duty');
  updateAugmentedFacilityOptions('modern-duty-crew','modern-duty-rest-facility');
  toggleRestFields('modern-rest-duty-type','modern-rest-unaug-fields');
  initTimeConverterModeSwitch({ selectId: 'modern-time-mode', utcGroupId: 'modern-time-utc-group', otherGroupId: 'modern-time-other-group', noteId: 'modern-time-note' });
  attachTimeConverter({ airportId: 'modern-time-airport', localId: 'modern-time-local', utcId: 'modern-time-utc', noteId: 'modern-time-note' });
  attachAirportToAirportConverter({ fromAirportId: 'modern-time-from-airport', toAirportId: 'modern-time-to-airport', fromTimeId: 'modern-time-from', toTimeId: 'modern-time-to', noteId: 'modern-time-note' });
  attachFinLookup({ inputId: 'modern-fin-input', outId: 'modern-fin-out' });
  refreshFinCodeToggleButtons();
  setFlightLookupCarrier(flightLookupCarrier);
  populateFr24ConfigForm();
  investigateBackgroundFinSync();
  initCalendar();
  // After initializing defaults and tie logic, automatically select the
  // current pay year and step.  This runs once on page load and does not
  // lock the controls.  If tie checkboxes remain unchecked, this does
  // nothing beyond setting defaults.
  autoSelectDefaults();
  syncAdvancedRrsp(true);
  // Sensible placeholders for weather tab
  const depWx = document.getElementById('wx-dep'); if (depWx && !depWx.value) depWx.value = 'YWG';
  const arrWx = document.getElementById('wx-arr'); if (arrWx && !arrWx.value) arrWx.value = 'YYZ';
  const depWxM = document.getElementById('modern-wx-dep'); if (depWxM && !depWxM.value) depWxM.value = 'YWG';
  const arrWxM = document.getElementById('modern-wx-arr'); if (arrWxM && !arrWxM.value) arrWxM.value = 'YYZ';
  startWeatherPrimeLoop();
}
if (document.readyState === 'loading'){ document.addEventListener('DOMContentLoaded', init); } else { init(); }
// PWA: register the service worker
if ('serviceWorker' in navigator) {
  let swReloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swReloading) return;
    swReloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then((reg) => reg.update?.())
      .catch(() => { /* no-op */ });
  });
}
