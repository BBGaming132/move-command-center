import type { DerivedItemState, InventoryItem } from '../types';

export interface SearchMatch {
  matched: boolean;
  score: number;
  exactId: boolean;
  reasons: string[];
}

interface SearchDocument {
  itemId: string;
  numericId?: number;
  fields: Record<string, string>;
  wordsByField: Record<string, Set<string>>;
  all: string;
  allWords: Set<string>;
}

const CONTROL_WORDS = new Set(['item', 'items', 'piece', 'pieces', 'inventory', 'number', 'no']);

const SYNONYM_GROUPS: string[][] = [
  ['xmas', 'christmas', 'holiday'],
  ['tv', 'television'],
  ['photo', 'photos', 'picture', 'pictures'],
  ['dvd', 'dvds', 'disc', 'discs'],
  ['clothes', 'clothing', 'apparel'],
  ['sofa', 'couch'],
  ['lamp', 'light', 'lighting'],
  ['ornament', 'ornaments', 'decor', 'decoration', 'decorations'],
  ['file', 'files', 'paper', 'papers', 'document', 'documents'],
  ['blanket', 'blankets', 'linen', 'linens'],
  ['towel', 'towels', 'linen', 'linens'],
  ['dish', 'dishes', 'plate', 'plates', 'kitchenware'],
  ['glass', 'glasses', 'glassware'],
  ['toy', 'toys', 'game', 'games'],
  ['bag', 'bags', 'luggage', 'suitcase', 'suitcases'],
  ['office', 'work', 'desk'],
  ['crate', 'pallet', 'container'],
  ['extra', 'unexpected', 'emergency', 'unlisted']
];

const SYNONYMS = buildSynonymMap();

export function evaluateSearch(item: InventoryItem, state: DerivedItemState, query: string): SearchMatch {
  const trimmed = query.trim();
  if (!trimmed) return { matched: true, score: 0, exactId: false, reasons: [] };

  const document = buildDocument(item, state);
  const exactIdQuery = parseExactIdQuery(trimmed);
  if (exactIdQuery) {
    const exact = normalizeId(exactIdQuery) === normalizeId(item.itemId);
    return {
      matched: exact,
      score: exact ? 100_000 : 0,
      exactId: exact,
      reasons: exact ? [`exact item ${displayId(item.itemId)}`] : []
    };
  }

  const range = parseRangeQuery(trimmed);
  if (range) {
    const numericId = document.numericId;
    const matched = numericId !== undefined && numericId >= range.from && numericId <= range.to;
    return {
      matched,
      score: matched ? 90_000 - numericId : 0,
      exactId: false,
      reasons: matched ? [`item range ${range.from}-${range.to}`] : []
    };
  }

  const clauses = tokenizeQuery(trimmed);
  if (!clauses.length) return { matched: true, score: 0, exactId: false, reasons: [] };

  let score = 0;
  const reasons: string[] = [];
  let exactId = false;

  for (let index = 0; index < clauses.length; index += 1) {
    const rawClause = clauses[index] ?? '';
    const fieldClause = parseFieldClause(rawClause);

    if (fieldClause) {
      const fieldName = normalizeFieldName(fieldClause.field);
      const value = stripQuotes(fieldClause.value);
      const result = matchField(document, fieldName, value);
      if (!result.matched) return { matched: false, score: 0, exactId: false, reasons: [] };
      score += result.score;
      exactId ||= result.exactId;
      reasons.push(result.reason);
      continue;
    }

    const normalizedClause = normalizeText(stripQuotes(rawClause));
    if (!normalizedClause) continue;

    if (isNumericToken(normalizedClause)) {
      const matched = document.numericId !== undefined && document.numericId === Number(normalizedClause);
      if (!matched) return { matched: false, score: 0, exactId: false, reasons: [] };
      score += 80_000;
      exactId = true;
      reasons.push(`item ${normalizedClause}`);
      continue;
    }

    if (CONTROL_WORDS.has(normalizedClause)) {
      const next = normalizeText(stripQuotes(clauses[index + 1] ?? ''));
      if (isNumericToken(next)) continue;
    }

    const result = matchText(document, normalizedClause);
    if (!result.matched) return { matched: false, score: 0, exactId: false, reasons: [] };
    score += result.score;
    reasons.push(result.reason);
  }

  return {
    matched: true,
    score,
    exactId,
    reasons: unique(reasons).slice(0, 4)
  };
}

export function matchesSearch(searchText: string, query: string): boolean {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return true;
  const haystack = normalizeText(searchText);
  return normalizedQuery.split(' ').filter(Boolean).every((token) => hasWholeOrPrefixWord(haystack, token));
}

export function createSearchText(item: InventoryItem, state: DerivedItemState): string {
  return buildDocument(item, state).all;
}

export function normalizeForSort(value: unknown): string {
  return normalizeText(value);
}

function buildDocument(item: InventoryItem, state: DerivedItemState): SearchDocument {
  const content = String(item.sourceFields.Content ?? item.description ?? '');
  const comments = String(item.sourceFields.Comments ?? '');
  const packType = item.originalCode || String(item.sourceFields['Pack Type'] ?? '');
  const originalRoom = item.originalRoom || String(item.sourceFields['Original Room'] ?? '');
  const packer = String(item.sourceFields.Packer ?? '');
  const assignedCrate = state.assignedCrateId || item.crateId || '';
  const destination = state.keepOriginalRoom
    ? originalRoom
    : [state.destinationCode, state.destinationLabel].filter(Boolean).join(' ');
  const sourceValues = Object.entries(item.sourceFields)
    .flatMap(([key, value]) => [key, value])
    .join(' ');

  const derivedTags = getGeneratedSearchTags(item, state);
  const fields: Record<string, string> = {
    id: normalizeText(item.itemId),
    content: normalizeText([content, item.description].join(' ')),
    comments: normalizeText(comments),
    room: normalizeText(originalRoom),
    pack: normalizeText(packType),
    packer: normalizeText(packer),
    crate: normalizeText(assignedCrate),
    destination: normalizeText(destination),
    notes: normalizeText([state.notes, state.latestIssue].filter(Boolean).join(' ')),
    tags: normalizeText([...item.tags, ...derivedTags].join(' ')),
    source: normalizeText([item.rawLine, item.sourceRow, item.sourcePage, sourceValues].join(' ')),
    status: normalizeText([
      state.received ? 'received complete checked in' : 'remaining not received unchecked',
      state.issueCount ? 'issue problem discrepancy' : 'clear no issue',
      (state.keepOriginalRoom || state.destinationCode || state.destinationLabel) ? 'routed destination assigned' : 'no destination unrouted',
      assignedCrate && assignedCrate !== 'UNASSIGNED' ? 'crate assigned' : 'no crate unassigned',
      item.isAdHoc ? 'extra unexpected emergency unlisted' : 'verified master inventory',
      item.sourceFields['High Value'] === true ? 'high value hv fragile' : ''
    ].join(' '))
  };

  const all = normalizeText(Object.values(fields).join(' '));
  const wordsByField = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, new Set(expandWords(value))])
  );

  return {
    itemId: item.itemId,
    numericId: /^\d+$/.test(item.itemId) ? Number(item.itemId) : undefined,
    fields,
    wordsByField,
    all,
    allWords: new Set(expandWords(all))
  };
}

export function getGeneratedSearchTags(item: InventoryItem, state: DerivedItemState): string[] {
  const values = [
    item.itemId,
    `item ${item.itemId}`,
    `piece ${item.itemId}`,
    `inventory ${item.itemId}`,
    item.description,
    item.originalRoom,
    item.originalCode,
    item.sourceFields.Content,
    item.sourceFields.Comments,
    item.sourceFields.Packer,
    state.assignedCrateId,
    state.destinationCode,
    state.destinationLabel,
    state.keepOriginalRoom ? item.originalRoom : '',
    state.keepOriginalRoom ? 'keep original room unchanged same room' : '',
    state.notes,
    state.latestIssue,
    item.isAdHoc ? 'extra unexpected emergency unlisted item' : 'master inventory item'
  ];

  const words = expandWords(normalizeText(values.join(' ')));
  const expanded = new Set<string>(words);
  for (const word of words) {
    for (const synonym of SYNONYMS.get(word) ?? []) expanded.add(synonym);
  }
  return [...expanded];
}

function matchField(
  document: SearchDocument,
  field: string,
  rawValue: string
): { matched: boolean; score: number; exactId: boolean; reason: string } {
  const value = normalizeText(rawValue);
  if (!value) return { matched: true, score: 0, exactId: false, reason: field };

  if (field === 'id') {
    const matched = normalizeId(rawValue) === normalizeId(document.itemId);
    return { matched, score: matched ? 100_000 : 0, exactId: matched, reason: `exact item ${displayId(document.itemId)}` };
  }

  if (field === 'status') {
    const statusText = document.fields.status ?? '';
    const matched = value.split(' ').every((token) => hasWholeOrPrefixWord(statusText, token));
    return { matched, score: matched ? 12_000 : 0, exactId: false, reason: `status: ${rawValue}` };
  }

  const actualField = field === 'dest' ? 'destination' : field === 'package' ? 'pack' : field;
  const haystack = document.fields[actualField];
  if (haystack === undefined) return { matched: false, score: 0, exactId: false, reason: field };
  const words = document.wordsByField[actualField] ?? new Set<string>();
  const matched = matchValue(haystack, words, value);
  const score = matched ? fieldScore(actualField, haystack, value) : 0;
  return { matched, score, exactId: false, reason: `${fieldLabel(actualField)}: ${rawValue}` };
}

function matchText(document: SearchDocument, value: string): { matched: boolean; score: number; reason: string } {
  const fieldsInOrder = ['content', 'comments', 'tags', 'room', 'pack', 'destination', 'crate', 'notes', 'packer', 'source', 'status'];
  for (const field of fieldsInOrder) {
    const haystack = document.fields[field] ?? '';
    const words = document.wordsByField[field] ?? new Set<string>();
    if (matchValue(haystack, words, value)) {
      return {
        matched: true,
        score: fieldScore(field, haystack, value),
        reason: fieldLabel(field)
      };
    }
  }
  return { matched: false, score: 0, reason: '' };
}

function matchValue(haystack: string, words: Set<string>, value: string): boolean {
  if (!value) return true;
  if (value.includes(' ')) return containsPhrase(haystack, value);

  const candidates = expandQueryWord(value);
  return candidates.some((candidate) => {
    if (words.has(candidate)) return true;
    if (candidate.length >= 3) return [...words].some((word) => word.startsWith(candidate));
    return false;
  });
}

function fieldScore(field: string, haystack: string, value: string): number {
  const base: Record<string, number> = {
    content: 8_000,
    comments: 7_000,
    tags: 6_000,
    destination: 5_500,
    room: 5_000,
    pack: 4_800,
    crate: 4_600,
    notes: 4_400,
    packer: 3_000,
    status: 2_500,
    source: 1_000
  };
  const exactPhraseBonus = haystack === value ? 1_500 : containsPhrase(haystack, value) ? 700 : 0;
  return (base[field] ?? 500) + exactPhraseBonus;
}

function parseExactIdQuery(query: string): string | undefined {
  const normalized = query.trim();
  const numeric = normalized.match(/^(?:#|item\s*#?\s*|piece\s*#?\s*|inventory\s*#?\s*)?(\d{1,3})$/i);
  if (numeric) return String(Number(numeric[1]));
  const extra = normalized.match(/^(?:#|item\s*#?\s*)?(extra-[a-z0-9]{8,24})$/i);
  return extra?.[1]?.toUpperCase();
}

function parseRangeQuery(query: string): { from: number; to: number } | undefined {
  const match = query.trim().match(/^(?:items?\s*)?(\d{1,3})\s*(?:-|–|—|\.\.|\bto\b|\bthrough\b)\s*(\d{1,3})$/i);
  if (!match) return undefined;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return { from: Math.min(first, second), to: Math.max(first, second) };
}

function parseFieldClause(clause: string): { field: string; value: string } | undefined {
  const match = clause.match(/^([a-z]+):(.*)$/i);
  if (!match || !match[2]) return undefined;
  return { field: match[1] ?? '', value: match[2] ?? '' };
}

function tokenizeQuery(query: string): string[] {
  return query.match(/(?:[a-z]+:)?"[^"]+"|\S+/gi) ?? [];
}

function normalizeFieldName(field: string): string {
  const normalized = field.toLowerCase();
  const aliases: Record<string, string> = {
    item: 'id',
    piece: 'id',
    inventory: 'id',
    original: 'room',
    type: 'pack',
    pkg: 'pack',
    package: 'pack',
    currentcrate: 'crate',
    destination: 'destination',
    dest: 'destination',
    comment: 'comments',
    description: 'content',
    desc: 'content',
    note: 'notes',
    issue: 'notes',
    hv: 'status'
  };
  return aliases[normalized] ?? normalized;
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    content: 'description',
    comments: 'details',
    tags: 'keyword tag',
    room: 'original room',
    pack: 'package type',
    destination: 'destination',
    crate: 'current crate',
    notes: 'move note',
    packer: 'packer',
    source: 'source record',
    status: 'status'
  };
  return labels[field] ?? field;
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeId(value: string): string {
  const trimmed = value.trim().toUpperCase();
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed;
}

function expandWords(value: string): string[] {
  const words = normalizeText(value).split(' ').filter(Boolean);
  const expanded = new Set<string>();
  for (const word of words) {
    expanded.add(word);
    const stem = simpleStem(word);
    if (stem) expanded.add(stem);
    for (const synonym of SYNONYMS.get(word) ?? []) expanded.add(synonym);
  }
  return [...expanded];
}

function expandQueryWord(word: string): string[] {
  const normalized = normalizeText(word);
  const expanded = new Set<string>([normalized]);
  const stem = simpleStem(normalized);
  if (stem) expanded.add(stem);
  for (const synonym of SYNONYMS.get(normalized) ?? []) expanded.add(synonym);
  return [...expanded].filter(Boolean);
}

function simpleStem(word: string): string {
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function containsPhrase(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.includes(` ${phrase} `) || haystack.includes(phrase);
}

function hasWholeOrPrefixWord(haystack: string, token: string): boolean {
  const words = new Set(expandWords(haystack));
  return expandQueryWord(token).some((candidate) => words.has(candidate) || (candidate.length >= 3 && [...words].some((word) => word.startsWith(candidate))));
}

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/g, '');
}

function isNumericToken(value: string): boolean {
  return /^\d{1,3}$/.test(value);
}

function displayId(itemId: string): string {
  return /^\d+$/.test(itemId) ? `#${Number(itemId)}` : itemId;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function buildSynonymMap(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    const normalized = group.map((word) => normalizeText(word));
    for (const word of normalized) {
      const values = map.get(word) ?? new Set<string>();
      for (const other of normalized) if (other !== word) values.add(other);
      map.set(word, values);
    }
  }
  return map;
}
