import { load } from 'cheerio';
import { ProviderFailure } from '../reading-provider/provider.types';

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function apolloBook(html: string, legacyId: string) {
  const $ = load(html);
  const key = `getBookByLegacyId({"legacyId":"${legacyId}"})`;
  let result: { cache: Record<string, unknown>; book: Record<string, unknown> } | undefined;
  function visit(value: unknown, depth: number): void {
    if (result || depth > 16) return;
    const record = object(value);
    const ref = object(object(record.ROOT_QUERY)[key]).__ref;
    if (typeof ref === 'string' && record[ref]) {
      result = { cache: record, book: object(record[ref]) };
      return;
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  }
  $('script').each((_index, element) => {
    const text = $(element).text();
    if (!text.includes('getBookByLegacyId')) return;
    try {
      visit(JSON.parse(text), 0);
    } catch {
      /* Other scripts are executable code, not JSON. */
    }
  });
  if (!result) throw new ProviderFailure('page_changed', 'Goodreads book state is unreadable. No remote state was changed.');
  return result;
}
export function resolve(cache: Record<string, unknown>, value: unknown): Record<string, unknown> {
  const record = object(value);
  return typeof record.__ref === 'string' ? object(cache[record.__ref]) : record;
}
export function flightText(html: string): string {
  const $ = load(html);
  const values: string[] = [];
  $('script').each((_index, element) => {
    const script = $(element).text();
    for (const match of script.matchAll(/self\.__next_f\.push\((\[.*?\])\)\s*;?/g)) {
      try {
        const value: unknown = JSON.parse(match[1]!);
        if (Array.isArray(value) && typeof value[1] === 'string') values.push(value[1]);
      } catch {
        /* Fail closed on an unfamiliar Flight encoding. */
      }
    }
  });
  return values.join('');
}
export function flightValue(text: string, key: string): unknown {
  const marker = JSON.stringify(key) + ':';
  const index = text.indexOf(marker);
  if (index < 0) return undefined;
  const start = index + marker.length;
  const remainder = text.slice(start).trimStart();
  const first = remainder[0];
  let quoted = first === '"';
  let escaped = false;
  let depth = first === '[' || first === '{' ? 1 : 0;
  if (!quoted && depth === 0) {
    const primitive = /^(?:true|false|null|-?\d+(?:\.\d+)?)/.exec(remainder)?.[0];
    if (primitive) {
      try {
        return JSON.parse(primitive);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  for (let index = 1; index < Math.min(remainder.length, 100_000); index++) {
    const character = remainder[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '[' || character === '{') depth++;
    else if (character === ']' || character === '}') depth--;
    if (!quoted && depth === 0) {
      try {
        return JSON.parse(remainder.slice(0, index + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
export function fullDate(value: unknown): string | null {
  const date = object(value);
  if (!Number.isInteger(date.year) || !Number.isInteger(date.month) || !Number.isInteger(date.day)) return null;
  const iso = `${String(date.year)}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso)) ? iso : null;
}
