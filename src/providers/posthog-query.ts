import { OpsError } from '../core/result.js';

type Word = { value: string; start: number; end: number };

/** A deliberately small HogQL grammar: one SELECT over events, with no nested reads. */
function words(query: string): Word[] {
  const found: Word[] = [];
  let quote: string | undefined;
  for (let index = 0; index < query.length;) {
    const char = query[index];
    if (quote) {
      if (char === quote && query[index + 1] === quote) { index += 2; continue; }
      if (char === quote) quote = undefined;
      index++;
      continue;
    }
    if (char === '"' || char === '`') {
      throw new OpsError('REFUSED', 'HogQL quoted identifiers are not allowed');
    }
    if (char === '\'') { quote = char; index++; continue; }
    if (char === ';' || char === '#' || query.slice(index, index + 2) === '--' ||
      query.slice(index, index + 2) === '/*') {
      throw new OpsError('REFUSED', 'HogQL comments or multiple statements are not allowed');
    }
    if (/[a-z_$]/i.test(char ?? '')) {
      const start = index;
      while (/[a-z0-9_$]/i.test(query[index] ?? '')) index++;
      found.push({ value: query.slice(start, index).toLowerCase(), start, end: index });
      continue;
    }
    index++;
  }
  if (quote) throw new OpsError('REFUSED', 'HogQL has an unterminated quoted value');
  return found;
}

export function boundedHogql(query: string, from: string, to: string, maximumRows: number,
  maximumMinutes: number): { query: string; limit: number; window: { from: string; to: string } } {
  if (query.length > 4000 || !/(?:Z|[+-]\d{2}:\d{2})$/.test(from) ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(to)) {
    throw new OpsError('QUERY_LIMIT', 'HogQL or UTC window is invalid');
  }
  const start = Date.parse(from); const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
    end > Date.now() + 60_000 || end - start > maximumMinutes * 60_000) {
    throw new OpsError('QUERY_LIMIT', 'HogQL window exceeds configured bounds');
  }
  const tokens = words(query);
  const count = (value: string) => tokens.filter((word) => word.value === value).length;
  if (tokens[0]?.value !== 'select' || count('select') !== 1 || count('from') !== 1 ||
    ['with', 'union', 'join', 'into', 'insert', 'update', 'delete', 'alter', 'drop',
      'create', 'truncate', 'execute', 'show', 'grant', 'revoke', 'system', 'persons',
      'properties', 'distinct_id', 'person_id', 'email', 'name', '$ip', 'recording',
      'console', 'snapshot', 'url', 'remote', 'file', 's3'].some((word) => count(word)) ||
    count('where') > 1 || count('group') > 1 || count('order') > 1 || count('limit') > 1) {
    throw new OpsError('REFUSED', 'HogQL must be one safe SELECT from events');
  }
  const source = tokens.findIndex((word) => word.value === 'from');
  if (tokens[source + 1]?.value !== 'events') {
    throw new OpsError('REFUSED', 'HogQL can read only events');
  }
  const fromEnd = tokens[source + 1]?.end ?? 0;
  const projection = query.slice(tokens[0]?.end ?? 0, tokens[source]?.start ?? 0);
  if (projection.replace(/count\s*\(\s*\*\s*\)/gi, '').includes('*')) {
    throw new OpsError('REFUSED', 'HogQL may not return all event columns');
  }
  const firstClause = tokens.find((word, index) => index > source + 1 &&
    ['where', 'group', 'order', 'limit'].includes(word.value));
  if (query.slice(fromEnd, firstClause?.start ?? query.length).trim()) {
    throw new OpsError('REFUSED', 'HogQL table aliases and extra sources are not allowed');
  }
  const limitWord = tokens.find((word) => word.value === 'limit');
  const requestedLimit = limitWord ? Number(query.slice(limitWord.end).trim()) : maximumRows;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 1000 ||
    requestedLimit > maximumRows) {
    throw new OpsError('QUERY_LIMIT', 'HogQL LIMIT exceeds configured row cap');
  }
  const insertion = tokens.find((word, index) => index > source + 1 &&
    ['group', 'order', 'limit'].includes(word.value))?.start ?? query.length;
  const prefix = query.slice(0, insertion).trimEnd();
  const suffix = query.slice(insertion).trimStart();
  const utc = (value: number) => new Date(value).toISOString().slice(0, 19).replace('T', ' ');
  const window = `timestamp >= toDateTime('${utc(start)}', 'UTC') AND timestamp <= toDateTime('${utc(end)}', 'UTC')`;
  const whereWord = tokens.find((word) => word.value === 'where');
  const condition = whereWord ? query.slice(whereWord.end, insertion).trim() : '';
  if (whereWord && !condition) throw new OpsError('REFUSED', 'HogQL WHERE is empty');
  const windowed = whereWord
    ? `${query.slice(0, whereWord.end)} (${condition}) AND ${window}`
    : `${prefix} WHERE ${window}`;
  const bounded = `${windowed}${suffix ? ` ${suffix}` : ''}`;
  return { query: limitWord ? bounded : `${bounded} LIMIT ${requestedLimit}`,
    limit: requestedLimit, window: { from: new Date(start).toISOString(), to: new Date(end).toISOString() } };
}
