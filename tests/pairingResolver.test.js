const assert = require('assert');

const noop = () => {};

global.document = {
  readyState: 'loading',
  addEventListener: noop,
  getElementById: () => null,
  querySelectorAll: () => [],
  body: { classList: { toggle: noop } }
};

global.window = {
  addEventListener: noop,
  location: { reload: noop }
};

global.navigator = {};

global.localStorage = {
  getItem: () => null,
  setItem: noop,
  removeItem: noop
};

global.Headers = class {};

global.fetch = async () => ({ ok: false, text: async () => '' });

global.crypto = { randomUUID: () => 'uuid-placeholder' };

global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

global.cancelAnimationFrame = (id) => clearTimeout(id);

global.performance = { now: () => Date.now() };

global.self = {
  location: { origin: 'http://localhost' },
  addEventListener: noop,
  skipWaiting: noop,
  clients: { claim: noop }
};

global.caches = {
  open: async () => ({ addAll: noop, put: noop }),
  keys: async () => [],
  match: async () => null,
  delete: async () => true
};

const { resolvePairings } = require('../app.js');

const clone = (value) => JSON.parse(JSON.stringify(value));

const makeEvent = ({ date, label, identifiers, from, to, departureMinutes, arrivalMinutes }) => ({
  id: `${date}-${label}`,
  date,
  label,
  identifiers,
  deadhead: false,
  dutyMinutes: null,
  creditMinutes: 120,
  blockMinutes: 120,
  legs: [{ from, to }],
  segments: [{ from, to, departureMinutes, arrivalMinutes }],
  departureMinutes,
  arrivalMinutes,
  cancellation: null,
  blockGrowthMinutes: 0,
  pairingId: ''
});

const januaryEvents = {
  '2025-01-31': {
    events: [
      makeEvent({
        date: '2025-01-31',
        label: 'AC123',
        identifiers: ['Pairing AB12', 'AC123'],
        from: 'YYZ',
        to: 'YVR',
        departureMinutes: 600,
        arrivalMinutes: 720
      })
    ]
  }
};

const februaryEvents = {
  '2025-02-01': {
    events: [
      makeEvent({
        date: '2025-02-01',
        label: 'AC456',
        identifiers: ['AC456'],
        from: 'YVR',
        to: 'SFO',
        departureMinutes: 540,
        arrivalMinutes: 660
      })
    ]
  }
};

const mergedA = { ...clone(januaryEvents), ...clone(februaryEvents) };
const mergedB = { ...clone(februaryEvents), ...clone(januaryEvents) };

const resultA = resolvePairings(mergedA);
const resultB = resolvePairings(mergedB);

const pairingIdA = resultA.pairingIdByDate.get('2025-01-31');
const pairingIdB = resultB.pairingIdByDate.get('2025-01-31');

assert.ok(pairingIdA, 'Expected a pairing ID for 2025-01-31');
assert.strictEqual(pairingIdA, resultA.pairingIdByDate.get('2025-02-01'));
assert.strictEqual(pairingIdA, pairingIdB);

const pairingA = resultA.pairingsById.get(pairingIdA);
assert.deepStrictEqual(pairingA.days, ['2025-01-31', '2025-02-01']);

console.log('Pairing resolver regression tests passed.');
