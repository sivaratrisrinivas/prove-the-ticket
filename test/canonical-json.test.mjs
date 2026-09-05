import assert from 'node:assert/strict';
import test from 'node:test';

import {canonicalizeJson, hashCanonicalJson} from '../src/canonical-json.js';

test('serializes RFC 8785 number and literal examples', () => {
  assert.equal(canonicalizeJson(333333333.33333329), '333333333.3333333');
  assert.equal(canonicalizeJson(1e30), '1e+30');
  assert.equal(canonicalizeJson(4.50), '4.5');
  assert.equal(canonicalizeJson(2e-3), '0.002');
  assert.equal(canonicalizeJson(1e-27), '1e-27');
  assert.equal(canonicalizeJson(-0), '0');
  assert.equal(canonicalizeJson({literals: [null, true, false]}), '{"literals":[null,true,false]}');
});

test('matches the RFC 8785 composite serialization and UTF-8 digest', () => {
  const value = {
    numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27],
    string: "€$\u000f\nA'B\"\\\\\"/",
    literals: [null, true, false],
  };
  const canonicalHex = '7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c226e756d62657273223a5b3333333333333333332e333333333333332c31652b33302c342e352c302e3030322c31652d32375d2c22737472696e67223a22e282ac245c75303030665c6e4127425c225c5c5c5c5c222f227d';
  assert.deepEqual(Buffer.from(canonicalizeJson(value), 'utf8'), Buffer.from(canonicalHex, 'hex'));
  assert.equal(hashCanonicalJson(value), '2d5e01a318d0f0879ab568c4be289c8b1f64ef8921a53c6277d5e069978baacb');
});

test('matches every finite RFC 8785 Appendix B number vector', () => {
  const vectors = [
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ];
  for (const [hex, expected] of vectors) assert.equal(canonicalizeJson(Buffer.from(hex, 'hex').readDoubleBE(0)), expected, hex);
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => canonicalizeJson(value));
});

test('sorts object names by UTF-16 code units without changing strings', () => {
  const value = {
    '€': 'Euro Sign',
    '\r': 'Carriage Return',
    'דּ': 'Hebrew Letter Dalet With Dagesh',
    '1': 'One',
    '😀': 'Emoji: Grinning Face',
    '\u0080': 'Control',
    'ö': 'Latin Small Letter O With Diaeresis',
  };
  assert.equal(canonicalizeJson(value), '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}');
  assert.equal(canonicalizeJson({'2': 2, '10': 10}), '{"10":10,"2":2}');
  assert.notEqual(canonicalizeJson({value: 'é'}), canonicalizeJson({value: 'e\u0301'}));
});

test('rejects values outside the I-JSON data model', () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, 1n, Symbol('x'), () => {}]) {
    assert.throws(() => canonicalizeJson(value));
  }
  for (const value of ['\ud800', '\udfff', '\ufdd0', '\uffff', '\u{1ffff}']) {
    assert.throws(() => canonicalizeJson(value));
    assert.throws(() => canonicalizeJson({[value]: true}));
  }
  assert.throws(() => canonicalizeJson(new Array(1)));
  assert.throws(() => canonicalizeJson(new Date(0)));
  assert.throws(() => canonicalizeJson(new Map([['key', 'value']])));
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeJson(cyclic));
  const withAccessor = {};
  Object.defineProperty(withAccessor, 'value', {get: () => 1, enumerable: true});
  assert.throws(() => canonicalizeJson(withAccessor));
  const withSymbol = {[Symbol('value')]: 1};
  assert.throws(() => canonicalizeJson(withSymbol));
});

test('allows valid supplementary characters and repeated references', () => {
  const shared = {value: '😀'};
  assert.equal(canonicalizeJson([shared, shared]), '[{"value":"😀"},{"value":"😀"}]');
});

test('hashes canonical UTF-8 bytes', () => {
  assert.equal(hashCanonicalJson({b: 2, a: 1}), hashCanonicalJson({a: 1, b: 2}));
});
