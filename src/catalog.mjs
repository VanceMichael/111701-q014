import { buildCatalog, DataError, opportunityKey, sameContent } from './opportunity.mjs';

// 目录可以吸收多页来源；同一身份以更高修订号为准，同修订号内容不同
// 视为来源冲突。补充通知永远不写入目录。
export class Catalog {
  #byKey = new Map();
  #sources = new Map();

  ingest(page) {
    for (const opportunity of buildCatalog(page)) {
      const key = opportunityKey(opportunity);
      const previous = this.#byKey.get(key);
      if (!previous) {
        this.#byKey.set(key, opportunity);
        continue;
      }
      if (opportunity.revision > previous.revision) {
        this.#byKey.set(key, opportunity);
        continue;
      }
      if (
        opportunity.revision === previous.revision &&
        !sameContent(previous, opportunity)
      ) {
        throw new DataError('catalog_conflict', `同一修订号出现不同内容: ${key}`);
      }
    }
    this.#sources.set(page.source, {
      source: page.source,
      observedAt: page.observedAt ?? null,
    });
    return this;
  }

  get sources() {
    return [...this.#sources.values()]
      .map((page) => ({ ...page }))
      .sort((left, right) => left.source.localeCompare(right.source));
  }

  get opportunities() {
    return [...this.#byKey.values()]
      .sort((left, right) => opportunityKey(left).localeCompare(opportunityKey(right)))
      .map((opportunity) => structuredClone(opportunity));
  }

  byKey(key) {
    const opportunity = this.#byKey.get(key);
    return opportunity ? structuredClone(opportunity) : null;
  }

  index() {
    const byKey = new Map();
    const byId = new Map();
    const byExternal = new Map();
    for (const opportunity of this.#byKey.values()) {
      byKey.set(opportunityKey(opportunity), opportunity);
      const sameId = byId.get(opportunity.id) ?? [];
      sameId.push(opportunity);
      byId.set(opportunity.id, sameId);
      for (const [agency, externalId] of Object.entries(opportunity.externalIds)) {
        const externalKey = `${agency}\u0000${externalId}`;
        const sameExternal = byExternal.get(externalKey) ?? [];
        sameExternal.push(opportunity);
        byExternal.set(externalKey, sameExternal);
      }
    }
    return { byKey, byId, byExternal };
  }

  // 只接受强标识：来源+内部编号、唯一内部编号，或机构外部编号。
  // 不按名称匹配，以免把通知套到同名或相似项目上。
  resolve(reference) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
      throw new DataError('notice_reference_invalid', '通知的项目引用必须是对象');
    }
    const { source, id, agency, externalId } = reference;
    const index = this.index();
    const candidates = new Map();
    const add = (key) => {
      const opportunity = index.byKey.get(key);
      if (opportunity) candidates.set(key, opportunity);
    };

    const hasSource = source != null;
    const hasId = id != null;
    const hasAgency = agency != null;
    const hasExternalId = externalId != null;

    if (!hasSource && !hasId && !hasAgency && !hasExternalId) {
      throw new DataError('notice_reference_invalid', '通知缺少项目引用');
    }

    if (hasSource && !hasId) {
      throw new DataError('notice_reference_invalid', '给出 source 时也必须给出 id');
    }
    if (hasSource) {
      if (typeof source !== 'string' || !source.trim() ||
          typeof id !== 'string' || !id.trim()) {
        throw new DataError('notice_reference_invalid', 'source 和 id 必须是非空字符串');
      }
      add(`${source.trim()}:${id.trim()}`);
    } else if (hasId) {
      if (typeof id !== 'string' || !id.trim()) {
        throw new DataError('notice_reference_invalid', 'id 必须是非空字符串');
      }
      // 只给内部编号时，必须全目录唯一；跨来源重名交给下面的歧义检查处理。
      for (const opportunity of index.byId.get(id.trim()) ?? []) {
        add(opportunityKey(opportunity));
      }
    }

    if (hasAgency !== hasExternalId) {
      throw new DataError(
        'notice_reference_invalid',
        '外部编号引用需要同时给出 agency 和 externalId',
      );
    }
    if (hasAgency) {
      if (typeof agency !== 'string' || !agency.trim() ||
          typeof externalId !== 'string' || !externalId.trim()) {
        throw new DataError('notice_reference_invalid', 'agency 和 externalId 必须是非空字符串');
      }
      for (const opportunity of index.byExternal.get(
        `${agency.trim()}\u0000${externalId.trim()}`,
      ) ?? []) {
        add(opportunityKey(opportunity));
      }
    }

    if (candidates.size === 0) {
      throw new DataError('notice_unmatched', '通知引用无法对应到任何项目', {
        reference: structuredClone(reference),
      });
    }
    if (candidates.size > 1) {
      throw new DataError('notice_ambiguous', '通知引用对应到多个项目，拒绝猜测', {
        reference: structuredClone(reference),
        candidates: [...candidates.keys()].sort(),
      });
    }
    return structuredClone(candidates.values().next().value);
  }
}
