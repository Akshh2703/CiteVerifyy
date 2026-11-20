function splitReferencesClient(text: string) {
  const heading = /^[ \t]*(references|bibliography|works\s+cited|literature\s+cited|reference\s+list)[ \t]*$/im;
  const match = heading.exec(text);
  if (!match) return { body: text, refText: '', references: [] as string[] };
  const body = text.slice(0, match.index).trim();
  const refs = text.slice(match.index + match[0].length).trim();
  const lines = refs.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
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

function detectCitationsClient(text: string) {
  const patterns: Array<[string, RegExp]> = [
    ['numeric_bracket', /\[(\d+(?:\s*[-,;]\s*\d+)*)\]/gi],
    ['author_year', /\(([^()]{1,80}?(?:19|20)\d{2}[a-z]?[^()]*)\)/gi],
    ['doi', /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi],
    ['url', /https?:\/\/[^\s<>]+/gi],
  ];
  const out: Array<{ style_detected: string; text: string; start: number; end: number }> = [];
  const seen = new Set<string>();
  for (const [kind, pat] of patterns) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      const val = m[0].replace(/[.,;]+$/, '');
      const key = `${kind}::${val}::${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ style_detected: kind, text: val, start: m.index, end: m.index + m[0].length });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function detectClaimsClient(text: string) {
  const marker =
    /\b(is|are|was|were|has|have|shows?|demonstrates?|indicates?|suggests?|finds?|found|proves?|increases?|decreases?|improves?|reduces?|causes?|correlates?|associated|significant|result(?:s)?|study|studies|therefore|because)\b/i;
  const protectedText = text.replace(/e\.g\./g, 'e<dot>g<dot>').replace(/i\.e\./g, 'i<dot>e<dot>').replace(/et al\./g, 'et al<dot>');
  const chunks = protectedText.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/);
  const claims: Array<{ text: string; claim_id: string }> = [];
  for (const chunk of chunks) {
    const s = chunk.replace(/<dot>/g, '.').replace(/\s+/g, ' ').trim();
    if (s.length < 45 || s.length > 1200 || !marker.test(s)) continue;
    if (/^(references|bibliography|works cited|figure\s*\d+|table\s*\d+)\b/i.test(s)) continue;
    claims.push({ claim_id: `claim-${claims.length + 1}`, text: s });
    if (claims.length >= 300) break;
  }
  return claims;
}

function extractTextFromJsonString(raw: string): string {
  const parsed = JSON.parse(raw) as unknown;
  const lines: string[] = [];
  const refs: string[] = [];
  const walk = (val: unknown, hint = '') => {
    if (val === null || val === undefined) return;
    if (typeof val === 'string') {
      const t = val.trim();
      if (!t) return;
      if (/^(references?|bibliography|works_cited)$/i.test(hint)) refs.push(t);
      else lines.push(t);
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      if (hint) lines.push(`${hint}: ${String(val)}`);
    } else if (Array.isArray(val)) {
      val.forEach((v) => walk(v, hint));
    } else if (typeof val === 'object') {
      Object.entries(val as Record<string, unknown>).forEach(([k, v]) => walk(v, k));
    }
  };
  walk(parsed);
  return refs.length ? [...lines, 'References', ...refs].join('\n\n') : lines.join('\n\n');
}

function extractTextFromCsvString(raw: string): string {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"' && raw[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && raw[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) return '';
  const start = rows.length > 1 && rows[0].some((h) => /^(claim|text|statement|body|content|citation|reference)$/i.test(h)) ? 1 : 0;
  return rows.slice(start).map((r) => r.filter(Boolean).join(' ')).filter(Boolean).join('\n\n');
}

export async function clientFallbackSearchPapers(query: string, limit = 8) {
  const results: Array<Record<string, unknown>> = [];
  try {
    const cr = await fetch(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${limit}`);
    if (cr.ok) {
      const data = await cr.json();
      for (const it of data?.message?.items || []) {
        const authors = (it.author || []).map((a: { given?: string; family?: string }) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean);
        const dateParts = it['published-print']?.['date-parts'] || it['published-online']?.['date-parts'] || [[null]];
        results.push({
          title: it.title?.[0] || '',
          authors,
          year: dateParts?.[0]?.[0] ?? null,
          doi: it.DOI ?? null,
          url: it.URL ?? null,
          container: it['container-title']?.[0] || '',
          abstract: it.abstract ?? null,
          provider: 'Crossref',
          open_access: null,
          open_access_url: null,
          pdf_url: null,
        });
      }
    }
  } catch {
    // ignore crossref error
  }
  if (results.length < limit) {
    try {
      const oa = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}`);
      if (oa.ok) {
        const data = await oa.json();
        for (const it of data?.results || []) {
          results.push({
            title: it.title || '',
            authors: (it.authorships || []).map((a: { author?: { display_name?: string } }) => a.author?.display_name).filter(Boolean),
            year: it.publication_year ?? null,
            doi: it.doi ?? null,
            url: it.doi || it.id || null,
            container: it.primary_location?.source?.display_name || null,
            abstract: null,
            provider: 'OpenAlex',
            open_access: it.open_access?.is_oa ?? null,
            open_access_url: it.best_oa_location?.landing_page_url || it.best_oa_location?.pdf_url || null,
            pdf_url: it.best_oa_location?.pdf_url || null,
          });
        }
      }
    } catch {
      // ignore openalex error
    }
  }
  return { query, results: results.slice(0, limit) };
}

export async function clientFallbackAnalyzeFile(file: File) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || name.endsWith('.docx')) {
    throw new Error('PDF and DOCX parsing requires the Node.js backend server. On static hosting, paste text or upload .txt, .json, or .csv files.');
  }
  const raw = await file.text();
  let fullText = raw;
  if (name.endsWith('.json')) fullText = extractTextFromJsonString(raw);
  else if (name.endsWith('.csv')) fullText = extractTextFromCsvString(raw);
  if (!fullText.trim()) throw new Error('Uploaded file contains no readable text.');

  const { body, refText, references } = splitReferencesClient(fullText);
  const citations = detectCitationsClient(body);
  const claims = detectClaimsClient(body).map((c) => ({
    ...c,
    claim: c.text,
    verdict: 'Unverifiable',
  }));
  const items = await Promise.all(
    references.slice(0, 5).map(async (ref) => {
      const search = await clientFallbackSearchPapers(ref, 2);
      return { reference: ref, papers: search.results };
    }),
  );

  return {
    document: {
      filename: file.name,
      text_characters: fullText.length,
      reference_section_detected: Boolean(refText),
    },
    pages: [{ page: null, text: fullText }],
    claims,
    citations,
    references,
    claim_assessments: claims.map((c) => ({
      claim: c.claim,
      status: 'Pending evidence assessment',
      reason: 'Analyzed in browser mode without backend LLM evaluation.',
      evidence: [],
    })),
    paper_retrieval: { references_processed: items.length, items },
  };
}
