import { OpsError } from '../core/result.js';

type Word = { value: string; start: number; end: number };

/** A deliberately small HogQL grammar: one SELECT over events, with no nested reads. */
function words(query: string): Word[] {
  const found: Word[] = [];
  let quote: string | undefined;
  let depth = 0;
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
    if (char === '(') depth++;
    if (char === ')' && --depth < 0) {
      throw new OpsError('REFUSED', 'HogQL parentheses are unbalanced');
    }
    if (char === '[' || char === ']' || char === '{' || char === '}' || char === '\\') {
      throw new OpsError('REFUSED', 'HogQL nested data and escapes are not allowed');
    }
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
  if (depth !== 0) throw new OpsError('REFUSED', 'HogQL parentheses are unbalanced');
  return found;
}

function safeProjection(projection: string): string[] {
  const columns = projection.split(',').map((part) => part.trim().toLowerCase());
  if (columns.length < 1 || columns.length > 3 || columns.some((part) =>
    !/^(?:event|timestamp|count\s*\(\s*\*\s*\))$/.test(part))) {
    throw new OpsError('REFUSED', 'HogQL projection must use event, timestamp, or count(*) without aliases');
  }
  const canonical = columns.map((part) => part.startsWith('count') ? 'count' : part);
  if (new Set(canonical).size !== canonical.length) {
    throw new OpsError('REFUSED', 'HogQL projection has duplicate columns');
  }
  return canonical;
}

export function boundedHogql(query: string, from: string, to: string, maximumRows: number,
  maximumMinutes: number): { query: string; columns: string[]; limit: number;
    window: { from: string; to: string } } {
  const exactTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (query.length > 4000 || !exactTimestamp.test(from) || !exactTimestamp.test(to)) {
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
  const columns = safeProjection(projection);
  const firstClause = tokens.find((word, index) => index > source + 1 &&
    ['where', 'group', 'order', 'limit'].includes(word.value));
  if (query.slice(fromEnd, firstClause?.start ?? query.length).trim()) {
    throw new OpsError('REFUSED', 'HogQL table aliases and extra sources are not allowed');
  }
  const limitWord = tokens.find((word) => word.value === 'limit');
  const groupWord = tokens.find((word) => word.value === 'group');
  const orderWord = tokens.find((word) => word.value === 'order');
  if (groupWord) {
    const clause = query.slice(groupWord.end, orderWord?.start ?? limitWord?.start ?? query.length).trim();
    if (!/^by\s+(?:event|timestamp)$/i.test(clause) ||
      (orderWord !== undefined && orderWord.start < groupWord.start)) {
      throw new OpsError('REFUSED', 'HogQL GROUP BY accepts only event or timestamp');
    }
  }
  if (orderWord) {
    const clause = query.slice(orderWord.end, limitWord?.start ?? query.length).trim();
    if (!/^by\s+(?:event|timestamp|count\s*\(\s*\*\s*\))(?:\s+(?:asc|desc))?$/i.test(clause)) {
      throw new OpsError('REFUSED', 'HogQL ORDER BY accepts only a safe projected field');
    }
  }
  const requestedLimit = limitWord ? Number(query.slice(limitWord.end).trim()) : maximumRows;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 1000 ||
    requestedLimit > maximumRows) {
    throw new OpsError('QUERY_LIMIT', 'HogQL LIMIT exceeds configured row cap');
  }
  const insertion = tokens.find((word, index) => index > source + 1 &&
    ['group', 'order', 'limit'].includes(word.value))?.start ?? query.length;
  const prefix = query.slice(0, insertion).trimEnd();
  const suffix = query.slice(insertion).trimStart();
  const utc = (value: number) => new Date(value).toISOString().slice(0, -1).replace('T', ' ');
  const window = `timestamp >= toDateTime64('${utc(start)}', 3, 'UTC') AND timestamp <= toDateTime64('${utc(end)}', 3, 'UTC')`;
  const whereWord = tokens.find((word) => word.value === 'where');
  const condition = whereWord ? query.slice(whereWord.end, insertion).trim() : '';
  if (whereWord && !condition) throw new OpsError('REFUSED', 'HogQL WHERE is empty');
  if (whereWord) {
    const allowed = new Set(['event', 'timestamp', 'and', 'or', 'not', 'in', 'like', 'is', 'null']);
    if (words(condition).some((word) => !allowed.has(word.value))) {
      throw new OpsError('REFUSED', 'HogQL WHERE can filter only event or timestamp');
    }
  }
  const windowed = whereWord
    ? `${query.slice(0, whereWord.end)} (${condition}) AND ${window}`
    : `${prefix} WHERE ${window}`;
  const bounded = `${windowed}${suffix ? ` ${suffix}` : ''}`;
  return { query: limitWord ? bounded : `${bounded} LIMIT ${requestedLimit}`, columns,
    limit: requestedLimit, window: { from: new Date(start).toISOString(), to: new Date(end).toISOString() } };
}
