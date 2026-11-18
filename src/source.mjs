import { readFile } from 'node:fs/promises';

export async function readSource(path = new URL('../data/source.json', import.meta.url)) {
  const text = await readFile(path, 'utf8');
  const page = JSON.parse(text);
  if (!page.source || !Array.isArray(page.items)) {
    throw new Error('来源页缺少 source 或 items');
  }
  return page;
}

// 补充通知单独存放，不合并进来源页；这样原页面保持机构当初发布的样子。
export async function readNotices(
  path = new URL('../data/notices.json', import.meta.url),
) {
  const text = await readFile(path, 'utf8');
  const value = JSON.parse(text);
  const items = Array.isArray(value) ? value : value.notices;
  if (!Array.isArray(items)) {
    throw new Error('补充通知文件缺少 notices 数组');
  }
  return items;
}
