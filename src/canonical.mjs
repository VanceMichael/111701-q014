import { createHash } from 'node:crypto';

// 稳定序列化：对象键排序后输出，便于比较快照是否等价。
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

export function hashValue(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function clone(value) {
  return structuredClone(value);
}
