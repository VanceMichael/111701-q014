import { normalizePage } from './adapter.mjs';
import { readNotices, readSource } from './source.mjs';
import { RecordStore } from './store.mjs';
import { Catalog } from './catalog.mjs';
import { NoticeLog } from './notices.mjs';

export async function collect({ source = readSource, store = new RecordStore() } = {}) {
  const page = await source();
  const records = normalizePage(page).map((record) => store.save(record));
  return { source: page.source, observedAt: page.observedAt ?? null, records, store };
}

// 采集只负责“原页面事实”。补充通知单独入库并绑定到项目；二者从不互相改写。
export async function loadCatalog({
  source = readSource,
  notices: noticeSource = readNotices,
} = {}) {
  const page = await source();
  const catalog = new Catalog().ingest(page);
  const log = new NoticeLog();
  let rawNotices = [];
  try {
    rawNotices = await noticeSource();
  } catch (error) {
    // 没有通知文件是合法状态；其他读取错误必须暴露。
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const input of rawNotices) log.attach(catalog, input);
  return { page, catalog, notices: log };
}

if (
  typeof process !== 'undefined' &&
  process.argv?.[1] &&
  import.meta.url === `file://${process.argv[1]}`
) {
  const result = await collect();
  console.log(JSON.stringify({ source: result.source, count: result.records.length }, null, 2));
}
