import { normalizePage } from './adapter.mjs';
import { canonicalize } from './canonical.mjs';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class DataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DataError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function assertDate(value, field = 'date') {
  if (value == null) return null;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new DataError('date_invalid', `${field} 必须是 YYYY-MM-DD 格式`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new DataError('date_invalid', `${field} 不是有效日期: ${value}`);
  }
  return value;
}

export function requireDate(value, field = 'date') {
  if (value == null) {
    throw new DataError('date_invalid', `${field} 不能为空`);
  }
  return assertDate(value, field);
}

function sortedMap(value) {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
}

// 资格按“维度 -> 允许值集合”表达；null 表示该维度不限。
export function normalizeEligibility(value, field = 'eligibility') {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DataError('eligibility_invalid', `${field} 必须是对象`);
  }
  const result = {};
  for (const [rawDimension, allowed] of Object.entries(value)) {
    const dimension = rawDimension.trim();
    if (!dimension) {
      throw new DataError('eligibility_invalid', `${field} 包含空维度名`);
    }
    if (allowed == null) {
      result[dimension] = null;
      continue;
    }
    if (!Array.isArray(allowed)) {
      throw new DataError('eligibility_invalid', `${field}.${dimension} 必须是字符串数组或 null`);
    }
    result[dimension] = [
      ...new Set(
        allowed.map((entry) => {
          if (typeof entry !== 'string' || !entry.trim()) {
            throw new DataError('eligibility_invalid', `${field}.${dimension} 包含无效值`);
          }
          return entry.trim();
        }),
      ),
    ].sort();
  }
  return sortedMap(result);
}

export function normalizeExternalIds(value, field = 'externalIds') {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DataError('external_ids_invalid', `${field} 必须是对象`);
  }
  const result = {};
  for (const [rawAgency, externalId] of Object.entries(value)) {
    const agency = rawAgency.trim();
    if (!agency || typeof externalId !== 'string' || !externalId.trim()) {
      throw new DataError(
        'external_ids_invalid',
        `${field} 必须把机构名映射到非空外部编号`,
      );
    }
    result[agency] = externalId.trim();
  }
  return sortedMap(result);
}

export function opportunityKey(record) {
  return `${record.source}:${record.id}`;
}

// 把来源页中的一条记录规整为“基础页面事实”。补充通知不写回这里，
// 因此原页面在任何时候都保持原样。
export function toOpportunity(item, page) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new DataError('opportunity_invalid', '机会记录必须是对象');
  }
  const [base] = normalizePage({
    source: page.source,
    observedAt: page.observedAt,
    items: [item],
  });
  if (!Number.isInteger(base.revision) || base.revision < 0) {
    throw new DataError('opportunity_invalid', `机会 ${base.id} 的 revision 必须是非负整数`);
  }
  return {
    ...base,
    agency: item.agency == null ? null : String(item.agency).trim() || null,
    externalIds: normalizeExternalIds(item.externalIds),
    baseConditions: {
      deadline: assertDate(item.deadline ?? null, `${base.id}.deadline`),
      eligibility: normalizeEligibility(item.eligibility, `${base.id}.eligibility`),
    },
  };
}

// 同一页可能重复发布同一项目：更高修订号胜出。相同修订号但内容不同
// 说明来源互相矛盾，直接拒绝而不是任选一条。
export function buildCatalog(page) {
  if (!page || typeof page !== 'object' || !page.source || !Array.isArray(page.items)) {
    throw new DataError('page_invalid', '来源页缺少 source 或 items');
  }
  const selected = new Map();
  for (const item of page.items) {
    const opportunity = toOpportunity(item, page);
    const key = opportunityKey(opportunity);
    const previous = selected.get(key);
    if (!previous) {
      selected.set(key, opportunity);
      continue;
    }
    if (opportunity.revision > previous.revision) {
      selected.set(key, opportunity);
      continue;
    }
    if (opportunity.revision === previous.revision && !sameContent(previous, opportunity)) {
      throw new DataError('catalog_conflict', `同一修订号出现不同内容: ${key}`);
    }
  }
  return [...selected.values()].sort((left, right) =>
    opportunityKey(left).localeCompare(opportunityKey(right)),
  );
}

function sameContent(left, right) {
  const project = (record) => ({
    source: record.source,
    id: record.id,
    name: record.name,
    state: record.state,
    agency: record.agency,
    externalIds: record.externalIds,
    baseConditions: record.baseConditions,
  });
  return canonicalize(project(left)) === canonicalize(project(right));
}

export { sameContent };
