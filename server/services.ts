import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

try {
  if (typeof import.meta.resolve === 'function') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  }
} catch {
  // Fallback to pdfjs-dist default worker resolution
}

export const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.json', '.csv']);
export const VERDICTS = new Set([
  'Supported',
  'Partially supported',
  'Unsupported',
  'Contradicted',
  'Outdated',
  'Unverifiable',
]);

export interface PageData {
  page: number | null;
  text: string;
}

export interface CitationItem {
  style_detected: string;
  text: string;
  start: number;
  end: number;
  mapping_basis?: string;
  mapping_confidence?: string;
  matched_reference_index?: number | null;
  matched_reference?: string | null;
  match_score?: number;
  match_status?: string;
}

export interface ClaimCandidate {
  text: string;
  start: number;
  end: number;
  extraction_method: string;
  review_required: boolean;
  candidate_type: string;
  citations?: CitationItem[];
  citation_status?: string;
}

export interface ClaimResult {
  claim_id: string;
  claim: string;
  citations: CitationItem[];
  citation_matches: CitationItem[];
  evidence: unknown[];
  verdict: string;
  verdict_reason: string;
  human_verdict: string | null;
  human_approved: boolean;
  human_rejected: boolean;
  review_comments: string[];
  more_evidence_requested?: string;
}

export interface PaperMetadata {
  title: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
  url: string | null;
  container: string | null;
  abstract: string | null;
  provider: string;
  open_access: boolean | null;
  open_access_url: string | null;
  pdf_url: string | null;
  open_access_status: string | null;
  open_access_locations?: OpenAccessLocation[];
  full_text_retrieved?: boolean;
  full_text_url?: string | null;
  full_text_error?: string | null;
  passages?: string[];
  full_text_characters?: number;
}

export interface OpenAccessLocation {
  landing_page_url: string | null;
  pdf_url: string | null;
  repository_or_journal: string | null;
  is_oa: boolean | null;
  license: string | null;
}

const UA = 'CiteVerify/0.1 (open-access paper retrieval prototype)';

export async function extractPdfPages(data: Buffer): Promise<PageData[]> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const pages: PageData[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const lines: string[] = [];
      let currentLine = '';
      let lastY: number | null = null;
      for (const item of textContent.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
        const str = item.str ?? '';
        const y = Array.isArray(item.transform) ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
          if (currentLine.trim()) lines.push(currentLine.trim());
          currentLine = str;
        } else {
          currentLine += (currentLine && str && !currentLine.endsWith(' ') && !str.startsWith(' ') ? ' ' : '') + str;
        }
        if (item.hasEOL) {
          if (currentLine.trim()) lines.push(currentLine.trim());
          currentLine = '';
          lastY = null;
        } else {
          lastY = y;
        }
      }
      if (currentLine.trim()) lines.push(currentLine.trim());
      pages.push({ page: i, text: lines.join('\n').trim() });
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages;
}

export async function extractDocx(data: Buffer): Promise<PageData[]> {
  const result = await mammoth.extractRawText({ buffer: data });
  return [{ page: null, text: result.value.trim() }];
}

export function extractTxt(data: Buffer): PageData[] {
  return [{ page: null, text: data.toString('utf-8') }];
}

function collectJsonLines(value: unknown, lines: string[], refs: string[], keyHint = ''): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (/^(references?|bibliography|works_cited)$/i.test(keyHint)) {
      refs.push(trimmed);
    } else {
      lines.push(trimmed);
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (keyHint) lines.push(`${keyHint}: ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLines(item, lines, refs, keyHint);
    }
    return;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const preferredOrder = ['title', 'abstract', 'text', 'body', 'content', 'claim', 'claims', 'citation', 'citations', 'evidence', 'reason', 'references', 'reference'];
    const keys = [
      ...preferredOrder.filter((k) => k in obj),
      ...Object.keys(obj).filter((k) => !preferredOrder.includes(k)),
    ];
    for (const k of keys) {
      collectJsonLines(obj[k], lines, refs, k);
    }
  }
}

export function extractJson(data: Buffer): PageData[] {
  const raw = data.toString('utf-8').trim();
  if (!raw) return [{ page: null, text: '' }];
  const parsed = JSON.parse(raw) as unknown;
  const lines: string[] = [];
  const refs: string[] = [];
  collectJsonLines(parsed, lines, refs);
  const parts = [...lines];
  if (refs.length > 0) {
    parts.push('References', ...refs);
  }
  return [{ page: null, text: parts.join('\n\n') }];
}

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  if (row.some((c) => c.length > 0)) rows.push(row);
  return rows;
}

export function extractCsv(data: Buffer): PageData[] {
  const raw = data.toString('utf-8').replace(/^\uFEFF/, '');
  const rows = parseCsvRows(raw);
  if (rows.length === 0) return [{ page: null, text: '' }];

  const headers = rows[0].map((h) => h.toLowerCase());
  const looksLikeHeader =
    rows.length > 1 &&
    headers.some((h) => /^(claim|text|statement|body|content|citation|reference|source|title|abstract|doi|url)$/.test(h));

  const lines: string[] = [];
  const refs: string[] = [];
  const refColIndices = new Set<number>();

  if (looksLikeHeader) {
    headers.forEach((h, idx) => {
      if (/^(references?|bibliography)$/.test(h)) refColIndices.add(idx);
    });
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      const textParts: string[] = [];
      cells.forEach((val, idx) => {
        if (!val) return;
        if (refColIndices.has(idx)) {
          if (!refs.includes(val)) refs.push(val);
        } else {
          textParts.push(val);
        }
      });
      if (textParts.length > 0) {
        lines.push(textParts.join(' '));
      }
    }
  } else {
    for (const cells of rows) {
      const nonEmpty = cells.filter(Boolean);
      if (nonEmpty.length > 0) lines.push(nonEmpty.join(' '));
    }
  }

  const combined = [...lines];
  if (refs.length > 0) {
    combined.push('References', ...refs);
  }
  return [{ page: null, text: combined.join('\n\n') }];
}

export async function extractDocument(data: Buffer, suffix: string): Promise<PageData[]> {
  if (suffix === '.pdf') return extractPdfPages(data);
  if (suffix === '.docx') return extractDocx(data);
  if (suffix === '.txt') return extractTxt(data);
  if (suffix === '.json') return extractJson(data);
  if (suffix === '.csv') return extractCsv(data);
  throw new Error('Unsupported format');
}

export function splitReferences(text: string): { body: string; refText: string; references: string[] } {
  const heading = /^[ \t]*(references|bibliography|works\s+cited|literature\s+cited|reference\s+list)[ \t]*$/im;
  const match = heading.exec(text);
  if (!match) {
    return { body: text, refText: '', references: [] };
  }
  const body = text.slice(0, match.index).trim();
  const refs = text.slice(match.index + match[0].length).trim();
  const lines = refs
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const startPattern = /^(?:\[\s*\d+\s*\]|\d+[.)]\s+|[A-Z][A-Za-z’\-]+,\s*(?:[A-Z].*|\d{4}))/;
  const entries: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (cur.length > 0 && startPattern.test(line)) {
      entries.push(cur.join(' '));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) entries.push(cur.join(' '));
  return { body, refText: refs, references: entries };
}

export function detectCitations(text: string): CitationItem[] {
  const patterns: Array<[string, RegExp]> = [
    ['numeric_bracket', /\[(\d+(?:\s*[-,;]\s*\d+)*)\]/gi],
    ['author_year', /\(([^()]{1,80}?(?:19|20)\d{2}[a-z]?[^()]*)\)/gi],
    ['doi', /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi],
    ['url', /https?:\/\/[^\s<>]+/gi],
    ['footnote_marker', /(?<!\w)(?:\^\d{1,3}|\[\d{1,3}\])/gi],
  ];
  const out: CitationItem[] = [];
  const seen = new Set<string>();
  for (const [kind, pat] of patterns) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      const val = m[0].replace(/[.,;]+$/, '');
      const key = `${kind}::${val}::${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        style_detected: kind,
        text: val,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function detectClaims(text: string, maxClaims = 300): ClaimCandidate[] {
  const claims: ClaimCandidate[] = [];
  const marker =
    /\b(is|are|was|were|has|have|shows?|demonstrates?|indicates?|suggests?|finds?|found|proves?|increases?|decreases?|improves?|reduces?|causes?|correlates?|associated|significant|result(?:s)?|study|studies|therefore|because)\b/i;
  const protectedText = text
    .replace(/e\.g\./g, 'e<dot>g<dot>')
    .replace(/i\.e\./g, 'i<dot>e<dot>')
    .replace(/et al\./g, 'et al<dot>');

  const sentenceBoundary = /(?<=[.!?])\s+(?=[A-Z0-9(])/g;
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = sentenceBoundary.exec(protectedText)) !== null) {
    chunks.push({
      text: protectedText.slice(lastIdx, match.index),
      start: lastIdx,
      end: match.index,
    });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx <= protectedText.length) {
    chunks.push({
      text: protectedText.slice(lastIdx),
      start: lastIdx,
      end: protectedText.length,
    });
  }

  for (const chunk of chunks) {
    const s = chunk.text.replace(/<dot>/g, '.').replace(/\s+/g, ' ').trim();
    if (s.length < 45 || s.length > 1200 || !marker.test(s)) continue;
    if (/^(references|bibliography|works cited)\b/i.test(s)) continue;
    if (/^(figure|table)\s*\d+/i.test(s)) continue;
    claims.push({
      text: s,
      start: chunk.start,
      end: chunk.end,
      extraction_method: 'heuristic',
      review_required: true,
      candidate_type: 'statement',
    });
    if (claims.length >= maxClaims) break;
  }
  return claims;
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensSet(text: string): Set<string> {
  return new Set(normalizeForMatch(text).split(' ').filter((t) => t.length > 2));
}

export function matchCitationsToReferences(citations: CitationItem[], references: string[]): CitationItem[] {
  const refTokens = references.map((r) => tokensSet(r));
  return citations.map((citation) => {
    const raw = citation.text || '';
    const cNorm = normalizeForMatch(raw);
    let bestIdx = -1;
    let bestScore = 0;
    const cTokens = tokensSet(raw);
    for (let idx = 0; idx < references.length; idx++) {
      const rNorm = normalizeForMatch(references[idx]);
      let score = 0;
      if (cNorm && rNorm.includes(cNorm)) {
        score = 1.0;
      } else if (cNorm.startsWith('10.') && rNorm.includes(cNorm)) {
        score = 1.0;
      } else if (cTokens.size > 0 && refTokens[idx].size > 0) {
        let overlap = 0;
        for (const t of cTokens) {
          if (refTokens[idx].has(t)) overlap++;
        }
        score = overlap / Math.max(1, cTokens.size);
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }
    const threshold = citation.style_detected === 'author_year' ? 0.45 : 0.5;
    const matched = bestIdx >= 0 && bestScore >= threshold;
    return {
      ...citation,
      matched_reference_index: matched ? bestIdx : null,
      matched_reference: matched ? references[bestIdx] : null,
      match_score: Math.round(bestScore * 1000) / 1000,
      match_status: matched ? 'matched' : 'unmatched',
    };
  });
}

export function mapClaimsToCitations(
  claims: ClaimCandidate[],
  citations: CitationItem[],
  maxDistance = 350,
): ClaimCandidate[] {
  return claims.map((claim) => {
    const start = claim.start;
    const end = claim.end;
    const attached: CitationItem[] = [];
    if (typeof start === 'number' && typeof end === 'number') {
      for (const citation of citations) {
        const cstart = citation.start;
        if (typeof cstart !== 'number') continue;
        if (start <= cstart && cstart <= end) {
          attached.push({ ...citation, mapping_basis: 'same_sentence', mapping_confidence: 'high' });
        } else if (end <= cstart && cstart <= end + maxDistance) {
          attached.push({ ...citation, mapping_basis: 'adjacent_after_claim', mapping_confidence: 'medium' });
        }
      }
    }
    return {
      ...claim,
      citations: attached,
      citation_status: attached.length > 0 ? 'cited' : 'no_detected_citation',
    };
  });
}

export function buildAnalysis(
  pageData: PageData[],
  filename: string,
  documentId: string,
  fileType: string,
) {
  const fullText = pageData
    .map((p) => p.text || '')
    .filter(Boolean)
    .join('\n\n');
  const { body, refText, references } = splitReferences(fullText);
  const citations = detectCitations(body);
  const claims = detectClaims(body);
  const matches = matchCitationsToReferences(citations, references);
  const mapped = mapClaimsToCitations(claims, citations);

  const claimResults: ClaimResult[] = mapped.map((item, idx) => {
    const claimCites = item.citations || [];
    const citeTexts = new Set(claimCites.map((c) => String(c.text || '')));
    return {
      claim_id: `claim-${idx + 1}`,
      claim: item.text,
      citations: claimCites,
      citation_matches: matches.filter((m) => citeTexts.has(String(m.text || ''))),
      evidence: [],
      verdict: 'Unverifiable',
      verdict_reason:
        'No source full text has been retrieved and evaluated. Citation metadata and relevance alone are not proof.',
      human_verdict: null,
      human_approved: false,
      human_rejected: false,
      review_comments: [],
    };
  });

  return {
    document: {
      document_id: documentId,
      filename,
      file_type: fileType,
      page_count: fileType === 'pdf' ? pageData.length : null,
      text_characters: fullText.length,
      reference_section_detected: Boolean(refText),
    },
    pages: pageData,
    claims: claimResults,
    citations,
    citation_matches: matches,
    references,
    processing_notes: [
      'Claim and citation extraction are heuristic and may require reviewer correction.',
      'Claims are marked Unverifiable until claim-specific source evidence is assessed.',
      'Citation metadata matches do not establish that a citation supports a claim.',
      'Scanned documents require OCR; OCR is not currently enabled.',
    ],
  };
}

export function cleanDoi(value: string): string | null {
  const m = /(10\.\d{4,9}\/[^\s"<>]+)/i.exec(value);
  return m ? m[1].replace(/[.,;]+$/, '') : null;
}

function decodeAbstract(index: Record<string, number[]> | null | undefined): string | null {
  if (!index) return null;
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, word]) => word).join(' ');
}

function normalizeWork(item: Record<string, unknown>, provider: 'crossref' | 'openalex'): PaperMetadata {
  if (provider === 'crossref') {
    const authors: string[] = [];
    const rawAuthors = Array.isArray(item.author) ? (item.author as Array<Record<string, string>>) : [];
    for (const a of rawAuthors) {
      const name = [a.given, a.family].filter(Boolean).join(' ');
      if (name) authors.push(name);
    }
    const titleList = Array.isArray(item.title) ? (item.title as string[]) : [];
    const dateObj =
      (item['published-print'] as Record<string, unknown>) ||
      (item['published-online'] as Record<string, unknown>) ||
      (item.created as Record<string, unknown>) ||
      {};
    const dateParts = Array.isArray(dateObj['date-parts']) ? (dateObj['date-parts'] as number[][]) : [[null]];
    const year = dateParts[0]?.[0] ?? null;
    const containerList = Array.isArray(item['container-title']) ? (item['container-title'] as string[]) : [];
    return {
      title: titleList[0] ?? '',
      authors,
      year: typeof year === 'number' ? year : null,
      doi: (item.DOI as string) ?? null,
      url: (item.URL as string) ?? null,
      container: containerList[0] ?? '',
      abstract: (item.abstract as string) ?? null,
      provider: 'Crossref',
      open_access: null,
      open_access_url: null,
      pdf_url: null,
      open_access_status: null,
    };
  }

  const authorships = Array.isArray(item.authorships) ? (item.authorships as Array<Record<string, Record<string, string>>>) : [];
  const authors = authorships
    .filter((a) => a.author?.display_name)
    .map((a) => a.author.display_name);
  const oa = (item.open_access as Record<string, unknown>) || {};
  const best = (item.best_oa_location as Record<string, string>) || {};
  const primary = (item.primary_location as Record<string, Record<string, string>>) || {};
  return {
    title: (item.title as string) ?? null,
    authors,
    year: typeof item.publication_year === 'number' ? item.publication_year : null,
    doi: (item.doi as string) ?? null,
    url: (item.doi as string) || (item.id as string) || null,
    container: primary.source?.display_name ?? null,
    abstract: decodeAbstract(item.abstract_inverted_index as Record<string, number[]> | null),
    provider: 'OpenAlex',
    open_access: typeof oa.is_oa === 'boolean' ? oa.is_oa : null,
    open_access_url: best.landing_page_url || best.pdf_url || null,
    pdf_url: best.pdf_url || null,
    open_access_status: (oa.oa_status as string) ?? null,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function searchResearch(query: string, limit = 5, timeoutMs = 12000) {
  const q = query.trim();
  if (!q) return { query: q, results: [] as PaperMetadata[], errors: ['Query is empty'] };
  const clampedLimit = Math.max(1, Math.min(Math.trunc(limit) || 5, 10));
  const results: PaperMetadata[] = [];
  const errors: string[] = [];
  const doi = cleanDoi(q);

  try {
    const url = new URL('https://api.crossref.org/works');
    if (doi) {
      url.searchParams.set('filter', `doi:${doi}`);
    } else {
      url.searchParams.set('query.bibliographic', q);
    }
    url.searchParams.set('rows', String(clampedLimit));
    const r = await fetchWithTimeout(url.toString(), { headers: { 'User-Agent': UA } }, timeoutMs);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as { message?: { items?: Array<Record<string, unknown>> } };
    for (const it of data.message?.items || []) {
      results.push(normalizeWork(it, 'crossref'));
    }
  } catch (err) {
    errors.push(`Crossref: ${err instanceof Error ? err.name : 'Error'}`);
  }

  if (results.length < clampedLimit) {
    try {
      const url = new URL('https://api.openalex.org/works');
      url.searchParams.set('search', doi || q);
      url.searchParams.set('per-page', String(clampedLimit));
      const r = await fetchWithTimeout(url.toString(), { headers: { 'User-Agent': UA } }, timeoutMs);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { results?: Array<Record<string, unknown>> };
      for (const it of data.results || []) {
        const normalized = normalizeWork(it, 'openalex');
        const dup = results.some(
          (x) => (normalized.doi || '').toLowerCase() !== '' && (normalized.doi || '').toLowerCase() === (x.doi || '').toLowerCase(),
        );
        if (!dup) results.push(normalized);
      }
    } catch (err) {
      errors.push(`OpenAlex: ${err instanceof Error ? err.name : 'Error'}`);
    }
  }

  return {
    query: q,
    results: results.slice(0, clampedLimit),
    errors,
    retrieval_note:
      'Paper discovery results include metadata and legal Open Access links when indexed. Metadata/abstract matches are not full-text evidence verification.',
  };
}

export async function discoverOpenAccess(doiOrQuery: string, timeoutMs = 12000) {
  const doi = cleanDoi(doiOrQuery);
  const q = doi || doiOrQuery.trim();
  if (!q) return { query: q, open_access_locations: [] as OpenAccessLocation[], status: 'not_found' };

  try {
    const url = new URL('https://api.openalex.org/works');
    if (doi) {
      url.searchParams.set('filter', `doi:${doi}`);
      url.searchParams.set('per-page', '3');
    } else {
      url.searchParams.set('search', q);
      url.searchParams.set('per-page', '3');
    }
    const response = await fetchWithTimeout(url.toString(), { headers: { 'User-Agent': UA } }, timeoutMs);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { results?: Array<Record<string, unknown>> };
    const items = data.results || [];
    if (items.length === 0) {
      return { query: q, open_access_locations: [] as OpenAccessLocation[], status: 'not_found' };
    }
    const work = items[0];
    const rawLocations = Array.isArray(work.locations) ? (work.locations as Array<Record<string, unknown>>) : [];
    const locations: OpenAccessLocation[] = [];
    for (const loc of rawLocations) {
      const source = (loc.source as Record<string, unknown>) || {};
      const landing = (loc.landing_page_url as string) || null;
      const pdf = (loc.pdf_url as string) || null;
      if (!landing && !pdf) continue;
      if (!loc.is_oa && !pdf) continue;
      locations.push({
        landing_page_url: landing,
        pdf_url: pdf,
        repository_or_journal: (source.display_name as string) || null,
        is_oa: typeof loc.is_oa === 'boolean' ? loc.is_oa : null,
        license: (loc.license as string) || null,
      });
    }
    return {
      query: q,
      title: (work.title as string) || null,
      doi: (work.doi as string) || null,
      open_access_locations: locations,
      status: locations.length > 0 ? 'open_access_found' : 'no_open_access_location_found',
      note: 'Only public/open-access locations are returned. Restricted content is not bypassed.',
    };
  } catch (err) {
    return {
      query: q,
      open_access_locations: [] as OpenAccessLocation[],
      status: 'lookup_error',
      error: err instanceof Error ? err.name : 'Error',
    };
  }
}

async function getPdfFullTextFromUrl(url: string, timeoutMs = 7000): Promise<{ text: string; error: string | null }> {
  if (!url || !url.toLowerCase().startsWith('https://')) {
    return { text: '', error: 'Only HTTPS OA URLs are attempted.' };
  }
  try {
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, timeoutMs);
    if (!r.ok) {
      return { text: '', error: `Full text retrieval failed (HTTP ${r.status}).` };
    }
    const contentType = (r.headers.get('content-type') || '').toLowerCase();
    const arrayBuffer = await r.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    if (buf.length > 30 * 1024 * 1024) {
      return { text: '', error: 'PDF exceeds 30 MB retrieval limit.' };
    }
    const startsWithPdf = buf.subarray(0, 4).toString('ascii') === '%PDF';
    if (!contentType.includes('pdf') && !startsWithPdf) {
      return { text: '', error: 'URL did not return a PDF.' };
    }
    const pages = await extractPdfPages(buf);
    return { text: pages.map((p) => p.text).join('\n'), error: null };
  } catch (err) {
    return { text: '', error: `Full text retrieval failed (${err instanceof Error ? err.name : 'Error'}).` };
  }
}

export async function retrieveReference(reference: string, limit = 3) {
  const query = reference.trim();
  const result = await searchResearch(query, limit, 6000);
  const papers: PaperMetadata[] = await Promise.all(
    result.results.slice(0, limit).map(async (item) => {
      const doi = item.doi || '';
      const oa =
        doi || item.title
          ? await discoverOpenAccess(doi || item.title || query, 6000)
          : { status: 'not_found', open_access_locations: [] as OpenAccessLocation[] };
      const locations = oa.open_access_locations || [];
      let fullText = '';
      let fullTextError: string | null = null;
      let retrievedFrom: string | null = null;

      for (const loc of locations.slice(0, 2)) {
        if (loc.pdf_url) {
          const res = await getPdfFullTextFromUrl(loc.pdf_url, 7000);
          fullTextError = res.error;
          if (res.text.trim()) {
            fullText = res.text;
            retrievedFrom = loc.pdf_url;
            break;
          }
        }
      }

      let passages: string[] = [];
      if (fullText) {
        passages = fullText
          .split(/\n\s*\n/)
          .map((p) => p.replace(/\s+/g, ' ').trim())
          .filter((p) => p.length > 100)
          .slice(0, 20);
      }

      return {
        ...item,
        open_access_status: oa.status,
        open_access_locations: locations,
        full_text_retrieved: Boolean(fullText),
        full_text_url: retrievedFrom,
        full_text_error: fullTextError,
        passages,
        full_text_characters: fullText.length,
      };
    }),
  );

  return {
    reference: query,
    papers,
    search_errors: result.errors,
    retrieval_note:
      'Full text is only extracted from accessible public OA PDF URLs. Metadata/abstract-only results are not treated as full-text evidence.',
  };
}

export async function retrieveReferences(references: string[], maxRefs = 8) {
  const validRefs = references
    .map((r) => String(r).trim())
    .filter(Boolean)
    .slice(0, maxRefs);

  if (validRefs.length === 0) {
    return {
      references_processed: 0,
      items: [],
      note: 'Search and full-text retrieval are best-effort. No paywalls are bypassed.',
    };
  }

  const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000));
  const tasks = Promise.all(
    validRefs.map((ref) =>
      retrieveReference(ref, 3).catch(() => ({
        reference: ref,
        papers: [],
        search_errors: ['Retrieval error'],
        retrieval_note:
          'Full text is only extracted from accessible public OA PDF URLs. Metadata/abstract-only results are not treated as full-text evidence.',
      })),
    ),
  );

  const items = (await Promise.race([tasks, deadline])) ?? [];
  return {
    references_processed: items.length,
    items,
    note: 'Search and full-text retrieval are best-effort. No paywalls are bypassed.',
  };
}

export async function assessClaims(
  claims: Array<{ text?: string; claim?: string }>,
  retrieval: { items?: Array<{ papers?: PaperMetadata[] }> },
) {
  const key = (process.env.GROQ_API_KEY || '').trim();
  if (!key) {
    return claims.map((c) => ({
      claim: c.text || c.claim || '',
      status: 'Pending evidence assessment',
      reason: 'GROQ_API_KEY is not configured; no automated claim comparison was run.',
      evidence: [] as string[],
    }));
  }

  const paperContext: Array<{ paper: string | null; doi: string | null; passages: string[] }> = [];
  for (const group of retrieval.items || []) {
    for (const paper of group.papers || []) {
      if (paper.full_text_retrieved) {
        paperContext.push({
          paper: paper.title,
          doi: paper.doi,
          passages: (paper.passages || []).slice(0, 8),
        });
      }
    }
  }

  if (paperContext.length === 0) {
    return claims.map((c) => ({
      claim: c.text || c.claim || '',
      status: 'Unverifiable',
      reason: 'No retrieved full-text passages were available to assess this claim.',
      evidence: [] as string[],
    }));
  }

  const allowed = new Set(['Supported', 'Partially supported', 'Unsupported', 'Contradicted', 'Unverifiable']);
  const output = [];
  for (const claim of claims.slice(0, 60)) {
    const text = claim.text || claim.claim || '';
    const prompt = { claim: text, retrieved_papers: paperContext.slice(0, 12) };
    try {
      const r = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
            messages: [
              {
                role: 'system',
                content:
                  'Assess the claim strictly against the supplied extracted full-text passages. Never use general knowledge. If evidence is insufficient, return Unverifiable. Use statuses Supported, Partially supported, Unsupported, Contradicted, or Unverifiable. Return valid JSON with status, reason, and evidence (array of exact short quotes). Do not invent quotes.',
              },
              { role: 'user', content: JSON.stringify(prompt) },
            ],
            temperature: 0.1,
            max_tokens: 500,
          }),
        },
        30000,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      let raw = json.choices?.[0]?.message?.content || '';
      raw = raw.replace(/^```(?:json)?|```$/gi, '').trim();
      const obj = JSON.parse(raw) as { status?: string; reason?: string; evidence?: unknown[] };
      const status = allowed.has(obj.status || '') ? obj.status! : 'Unverifiable';
      output.push({
        claim: text,
        status,
        reason: String(obj.reason || '').slice(0, 1500),
        evidence: Array.isArray(obj.evidence) ? obj.evidence : [],
      });
    } catch (err) {
      output.push({
        claim: text,
        status: 'Unverifiable',
        reason: `Automated assessment failed (${err instanceof Error ? err.name : 'Error'}); human review required.`,
        evidence: [],
      });
    }
  }
  return output;
}

const STOP_WORDS = new Set(
  'a an the and or but if to of in on at by for from with without into over under is are was were be been being this that these those it its their his her they them we our you your as than then not no yes can could may might must will would should do does did have has had'.split(
    ' ',
  ),
);

function evidenceTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) || []).filter((t) => !STOP_WORDS.has(t));
}

export function searchEvidence(claim: string, pages: PageData[], limit = 5) {
  const claimTokens = evidenceTokens(claim);
  if (!claim.trim() || claimTokens.length === 0) {
    return { query: claim, passages: [], note: 'Enter a non-empty claim with searchable terms.' };
  }
  const claimCounts = new Map<string, number>();
  for (const t of claimTokens) {
    claimCounts.set(t, (claimCounts.get(t) || 0) + 1);
  }

  const candidates: Array<{
    page: number | null;
    passage: string;
    overlap_terms: string[];
    relevance_score: number;
    score_type: string;
  }> = [];

  for (const page of pages) {
    const text = String(page.text || '');
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 35);

    for (const sentence of sentences) {
      const sTokens = evidenceTokens(sentence);
      const sentCounts = new Map<string, number>();
      for (const t of sTokens) {
        sentCounts.set(t, (sentCounts.get(t) || 0) + 1);
      }
      let shared = 0;
      const overlapTerms: string[] = [];
      for (const [t, count] of claimCounts.entries()) {
        const sCount = sentCounts.get(t) || 0;
        if (sCount > 0) {
          shared += Math.min(count, sCount);
          overlapTerms.push(t);
        }
      }
      if (shared > 0) {
        overlapTerms.sort();
        const coverage = shared / Math.max(1, claimTokens.length);
        const precision = shared / Math.max(1, sTokens.length);
        const score = Math.round(100 * (0.75 * coverage + 0.25 * precision) * 10) / 10;
        candidates.push({
          page: page.page ?? null,
          passage: sentence,
          overlap_terms: overlapTerms,
          relevance_score: score,
          score_type: 'lexical_overlap',
        });
      }
    }
  }

  candidates.sort((a, b) => b.relevance_score - a.relevance_score || b.overlap_terms.length - a.overlap_terms.length);
  const seen = new Set<string>();
  const passages = [];
  const maxItems = Math.max(1, Math.min(limit, 20));
  for (const c of candidates) {
    const key = c.passage.toLowerCase().replace(/\W+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    passages.push(c);
    if (passages.length >= maxItems) break;
  }

  return {
    query: claim,
    passages,
    note: 'Passages are retrieved from the supplied document only. Lexical relevance is not proof that a passage supports or contradicts the claim.',
  };
}

interface ReviewEvent {
  timestamp: string;
  reviewer: string;
  action: string;
  claim_id: string | null;
  details: Record<string, unknown>;
}

interface ReviewSession {
  review_id: string;
  document_id: string;
  created_at: string;
  updated_at: string;
  payload: {
    claims: ClaimResult[];
    document: Record<string, unknown>;
    human_report_approved?: boolean;
  };
  events: ReviewEvent[];
}

const reviewStore = new Map<string, ReviewSession>();

export function createReview(
  reviewId: string,
  documentId: string,
  payload: { claims: ClaimResult[]; document: Record<string, unknown> },
) {
  const timestamp = new Date().toISOString();
  const session: ReviewSession = {
    review_id: reviewId,
    document_id: documentId,
    created_at: timestamp,
    updated_at: timestamp,
    payload,
    events: [
      {
        timestamp,
        reviewer: 'system',
        action: 'review_created',
        claim_id: null,
        details: { document_id: documentId },
      },
    ],
  };
  reviewStore.set(reviewId, session);
  return {
    review_id: reviewId,
    document_id: documentId,
    created_at: timestamp,
    updated_at: timestamp,
    claims: payload.claims,
    status: 'pending_review',
  };
}

export function getReview(reviewId: string) {
  return reviewStore.get(reviewId) ?? null;
}

export function updateReview(
  reviewId: string,
  reviewer: string,
  claimId: string | null,
  action: string,
  details: Record<string, unknown>,
) {
  const allowedActions = new Set([
    'approve_claim',
    'modify_verdict',
    'reject_analysis',
    'request_more_evidence',
    'approve_report',
  ]);
  if (!allowedActions.has(action)) {
    throw new Error('Invalid review action');
  }
  const session = reviewStore.get(reviewId);
  if (!session) return null;

  const claims = session.payload.claims || [];
  if (claimId !== null) {
    const target = claims.find((c) => String(c.claim_id) === claimId);
    if (!target) {
      const err = new Error('claim_id not found') as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    if (action === 'modify_verdict') {
      const verdict = details.verdict;
      if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) {
        throw new Error('Invalid verdict');
      }
      target.human_verdict = verdict;
    }
    if (action === 'approve_claim') target.human_approved = true;
    if (action === 'reject_analysis') target.human_rejected = true;
    if (action === 'request_more_evidence') target.more_evidence_requested = String(details.request || '');
    target.review_comments = target.review_comments || [];
    target.review_comments.push(String(details.comment || ''));
  }

  if (action === 'approve_report') {
    const unreviewed = claims.filter((c) => !(c.human_approved || c.human_rejected || c.human_verdict));
    if (unreviewed.length > 0) {
      throw new Error('All claims must be reviewed before approving the report');
    }
    session.payload.human_report_approved = true;
  }

  const timestamp = new Date().toISOString();
  session.updated_at = timestamp;
  session.events.push({ timestamp, reviewer, action, claim_id: claimId, details });
  return session;
}

export function buildReport(
  document: Record<string, unknown>,
  claims: Array<Record<string, unknown>>,
  review: ReviewSession | null = null,
) {
  const counts: Record<string, number> = {
    Supported: 0,
    'Partially supported': 0,
    Unsupported: 0,
    Contradicted: 0,
    Outdated: 0,
    Unverifiable: 0,
    'Pending human review': 0,
  };
  for (const c of claims) {
    let verdict = String(c.human_verdict || c.verdict || 'Pending human review');
    if (!(verdict in counts)) verdict = 'Pending human review';
    counts[verdict] += 1;
  }
  const approved = Boolean(review?.payload?.human_report_approved);
  return {
    report_version: '1.0',
    generated_at: new Date().toISOString(),
    document,
    summary: {
      claim_count: claims.length,
      verdict_counts: counts,
      human_approved: approved,
      report_status: approved ? 'human_verified' : 'draft_pending_human_review',
    },
    claims,
    review_events: review ? review.events : [],
    notice: 'AI analysis is a research aid. The report is not human verified unless a reviewer explicitly approves it.',
  };
}

export function reportMarkdown(report: ReturnType<typeof buildReport>): string {
  const doc = report.document || {};
  const summary = report.summary || {};
  const lines = [
    '# CiteVerify Evidence Report',
    '',
    `**Document:** ${String(doc.filename || 'Unknown')}`,
    `**Document ID:** ${String(doc.document_id || '')}`,
    `**Status:** ${String(summary.report_status || 'draft')}`,
    `**Claims analyzed:** ${String(summary.claim_count || 0)}`,
    '',
    '## Verdict summary',
    '',
  ];
  for (const [verdict, count] of Object.entries(summary.verdict_counts || {})) {
    lines.push(`- ${verdict}: ${count}`);
  }
  lines.push('', '## Claim review', '');
  report.claims.forEach((c, idx) => {
    lines.push(
      `### Claim ${idx + 1}`,
      String(c.claim || c.text || ''),
      `- AI verdict: ${String(c.verdict || 'Not assessed')}`,
      `- Human verdict: ${String(c.human_verdict || 'Pending')}`,
      `- Evidence strength: ${String(c.evidence_strength || 'Not assessed')}`,
      `- Reasoning: ${String(c.reasoning || 'No reasoning supplied')}`,
      '- Evidence:',
    );
    const evidence = Array.isArray(c.evidence) ? (c.evidence as Array<Record<string, unknown>>) : [];
    if (evidence.length > 0) {
      for (const e of evidence) {
        lines.push(`  - ${String(e.passage || '')} (page ${String(e.page || 'unknown')})`);
      }
    } else {
      lines.push('  - No evidence passages attached.');
    }
    lines.push('');
  });
  lines.push('', report.notice || '');
  return lines.join('\n');
}
