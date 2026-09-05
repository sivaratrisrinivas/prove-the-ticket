import {createHash} from 'node:crypto';

export class CanonicalJsonError extends TypeError {}

export function canonicalizeJson(value) {
  return serialize(value, new Set());
}

export const canonicalJson = canonicalizeJson;

export function hashCanonicalJson(value) {
  return createHash('sha256').update(Buffer.from(canonicalizeJson(value), 'utf8')).digest('hex');
}

function serialize(value, ancestors) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    validateUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalJsonError('Non-finite numbers are not valid canonical JSON.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype) throw new CanonicalJsonError('Only ordinary arrays are valid canonical JSON.');
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')
      || ownKeys.some((key) => key !== 'length' && !isArrayIndex(key))) {
      throw new CanonicalJsonError('Only dense JSON arrays are valid canonical JSON.');
    }
    enter(value, ancestors);
    const result = `[${Array.from({length: value.length}, (_, index) => {
      if (!Object.hasOwn(value, index)) throw new CanonicalJsonError('Sparse arrays are not valid canonical JSON.');
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) throw new CanonicalJsonError('Accessor properties are not valid canonical JSON.');
      return serialize(descriptor.value, ancestors);
    }).join(',')}]`;
    ancestors.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError('Only plain records are valid canonical JSON.');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new CanonicalJsonError('Symbol properties are not valid canonical JSON.');
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.some((key) => !Object.propertyIsEnumerable.call(value, key))) {
      throw new CanonicalJsonError('Non-enumerable properties are not valid canonical JSON.');
    }
    enter(value, ancestors);
    const result = `{${names.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new CanonicalJsonError('Accessor properties are not valid canonical JSON.');
      }
      validateUnicode(key);
      return `${JSON.stringify(key)}:${serialize(descriptor.value, ancestors)}`;
    }).join(',')}}`;
    ancestors.delete(value);
    return result;
  }
  throw new CanonicalJsonError('Only JSON values are valid canonical JSON.');
}

function enter(value, ancestors) {
  if (ancestors.has(value)) throw new CanonicalJsonError('Cyclic values are not valid canonical JSON.');
  ancestors.add(value);
}

function validateUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const codePoint = value.codePointAt(index);
        if (isNoncharacter(codePoint)) throw new CanonicalJsonError('Noncharacters are not valid I-JSON strings.');
        index += 1;
        continue;
      }
      throw new CanonicalJsonError('Lone surrogate code units are not valid Unicode.');
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError('Lone surrogate code units are not valid Unicode.');
    }
    if (isNoncharacter(code)) throw new CanonicalJsonError('Noncharacters are not valid I-JSON strings.');
  }
}

function isNoncharacter(codePoint) {
  return codePoint >= 0xfdd0 && codePoint <= 0xfdef || (codePoint & 0xffff) >= 0xfffe;
}

function isArrayIndex(key) {
  return typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}
