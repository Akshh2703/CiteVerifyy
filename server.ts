import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import {
  SUPPORTED_EXTENSIONS,
  assessClaims,
  buildAnalysis,
  buildReport,
  createReview,
  detectCitations,
  detectClaims,
  discoverOpenAccess,
  extractDocument,
  getReview,
  mapClaimsToCitations,
  matchCitationsToReferences,
  reportMarkdown,
  retrieveReferences,
  searchEvidence,
  searchResearch,
  splitReferences,
  updateReview,
} from './server/services.ts';
import type { ClaimResult } from './server/services.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getPortFromArgs(): number | null {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) {
    const p = Number(process.argv[idx + 1]);
    if (Number.isFinite(p) && p > 0) return p;
  }
  const eq = process.argv.find((a) => a.startsWith('--port='));
  if (eq) {
    const p = Number(eq.split('=')[1]);
    if (Number.isFinite(p) && p > 0) return p;
  }
  return null;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PORT = Number(process.env.PORT) || getPortFromArgs() || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

const app = express();
app.use(express.json({ limit: '10mb' }));

// API Routes
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'CiteVerify API', version: '0.2.0' });
});

app.post('/api/chat', async (req: Request, res: Response) => {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) {
    res.status(503).json({ detail: 'Set GROQ_API_KEY in environment and restart.' });
    return;
  }
  const payload = (req.body || {}) as Record<string, unknown>;
  const question = String(payload.question || '').trim();
  if (!question) {
    res.status(400).json({ detail: 'question is required' });
    return;
  }
  const analysis = payload.analysis;
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
    res.status(400).json({ detail: 'analysis must be an object' });
    return;
  }
  const analysisObj = analysis as Record<string, unknown>;
  const pages = Array.isArray(analysisObj.pages) ? analysisObj.pages : [];
  const docText = pages
    .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
    .map((p) => String(p.text || ''))
    .join('\n\n')
    .slice(0, 18000);

  const context = {
    document: analysisObj.document || {},
    claims: analysisObj.claims || [],
    citations: analysisObj.citations || [],
    references: analysisObj.references || [],
    citation_matches: analysisObj.citation_matches || [],
  };

  const systemPrompt =
    'You are CiteVerify, a research citation-checking assistant. Answer using the uploaded document context. Do not invent sources, evidence, DOIs, page numbers, or verification results. Extraction and citation metadata do not prove support. Clearly state that cited-paper full text has not been retrieved unless source passages are explicitly in context. Distinguish document text from inference.\n\nANALYSIS JSON:\n' +
    JSON.stringify(context) +
    '\n\nDOCUMENT TEXT:\n' +
    docText;

  const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: systemPrompt }];
  if (Array.isArray(payload.history)) {
    for (const m of payload.history.slice(-8)) {
      if (
        m &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.text === 'string'
      ) {
        messages.push({ role: m.role, content: m.text.slice(0, 3000) });
      }
    }
  }
  messages.push({ role: 'user', content: question });

  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 900 }),
      signal: controller.signal,
    });
    if (!r.ok) {
      const txt = await r.text();
      res.status(r.status).json({ detail: 'LLM provider error: ' + txt.slice(0, 400) });
      return;
    }
    const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      res.status(502).json({ detail: 'Unexpected LLM response.' });
      return;
    }
    res.json({ answer, provider: 'Groq', model });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      res.status(504).json({ detail: 'LLM request timed out. Try again.' });
      return;
    }
    res.status(502).json({ detail: 'Could not reach LLM provider.' });
  } finally {
    clearTimeout(timer);
  }
});

app.post('/api/analyze-document', upload.single('file'), async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ detail: 'Uploaded file is required' });
    return;
  }
  const filename = file.originalname || 'uploaded-file';
  const suffix = path.extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(suffix)) {
    res.status(415).json({ detail: 'Supported formats: PDF, DOCX, TXT, JSON, CSV' });
    return;
  }
  if (!file.buffer || file.buffer.length === 0) {
    res.status(400).json({ detail: 'Uploaded file is empty' });
    return;
  }

  let pageData;
  try {
    pageData = await extractDocument(file.buffer, suffix);
  } catch {
    res.status(422).json({ detail: 'Document could not be parsed. It may be corrupt, encrypted, or image-only.' });
    return;
  }

  const fullText = pageData
    .map((p) => p.text)
    .filter(Boolean)
    .join('\n\n');
  if (!fullText.trim()) {
    res.status(422).json({ detail: 'No selectable text found. Scanned PDFs require OCR, which is not enabled yet.' });
    return;
  }

  const { body, refText, references } = splitReferences(fullText);
  const citations = detectCitations(body);
  const claims = detectClaims(body);
  const citationMatches = matchCitationsToReferences(citations, references);
  const claimCitationMap = mapClaimsToCitations(claims, citations);
  const documentId = crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16);

  res.json({
    document_id: documentId,
    filename,
    file_type: suffix.slice(1),
    pages: pageData,
    page_count: suffix === '.pdf' ? pageData.length : null,
    text_characters: fullText.length,
    claims,
    citations,
    citation_matches: citationMatches,
    claim_citation_map: claimCitationMap,
    references,
    reference_section_detected: Boolean(refText),
    processing_notes: [
      'Claim detection is a transparent heuristic and produces candidates only.',
      'Citation pattern detection is style-agnostic but may miss unusual citation formats.',
      'DOCX/TXT pagination is unavailable; page numbers are not inferred.',
      'Scanned PDFs without selectable text are not OCR-processed.',
      'No source retrieval or support verdict is produced at this stage.',
    ],
  });
});

app.post('/api/analysis-pipeline', upload.single('file'), async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ detail: 'Uploaded file is required' });
    return;
  }
  const filename = file.originalname || 'uploaded-file';
  const suffix = path.extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(suffix)) {
    res.status(415).json({ detail: 'Supported formats: PDF, DOCX, TXT, JSON, CSV' });
    return;
  }
  if (!file.buffer || file.buffer.length === 0) {
    res.status(400).json({ detail: 'Uploaded file is empty' });
    return;
  }

  let pageData;
  try {
    pageData = await extractDocument(file.buffer, suffix);
  } catch {
    res.status(422).json({ detail: 'Document could not be parsed. It may be corrupt, encrypted, or image-only.' });
    return;
  }

  if (!pageData.some((p) => String(p.text || '').trim().length > 0)) {
    res.status(422).json({ detail: 'No selectable text found. Scanned PDFs require OCR, which is not enabled yet.' });
    return;
  }

  const docId = crypto.createHash('sha256').update(file.buffer).digest('hex').slice(0, 16);
  const analysis: Record<string, unknown> = buildAnalysis(pageData, filename, docId, suffix.slice(1));

  try {
    const refs = Array.isArray(analysis.references) ? (analysis.references as string[]) : [];
    const retrieval = await retrieveReferences(refs);
    analysis.paper_retrieval = retrieval;
    const claims = Array.isArray(analysis.claims) ? (analysis.claims as ClaimResult[]) : [];
    analysis.claim_assessments = await assessClaims(claims, retrieval);
  } catch (err) {
    analysis.paper_retrieval = {
      references_processed: 0,
      items: [],
      error: err instanceof Error ? err.name : 'Error',
      note: 'Paper retrieval could not be completed.',
    };
  }

  res.json(analysis);
});

app.post('/api/research-search', async (req: Request, res: Response) => {
  const payload = (req.body || {}) as Record<string, unknown>;
  const query = String(payload.query || '').trim();
  if (!query) {
    res.status(400).json({ detail: 'query is required' });
    return;
  }
  const rawLimit = Number(payload.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 5;
  res.json(await searchResearch(query, limit));
});

app.post('/api/match-citations', (req: Request, res: Response) => {
  const payload = (req.body || {}) as Record<string, unknown>;
  if (!Array.isArray(payload.citations) || !Array.isArray(payload.references)) {
    res.status(400).json({ detail: 'citations and references must be arrays' });
    return;
  }
  res.json({ matches: matchCitationsToReferences(payload.citations, payload.references) });
});

app.post('/api/map-claims-citations', (req: Request, res: Response) => {
  const payload = (req.body || {}) as Record<string, unknown>;
  if (!Array.isArray(payload.claims) || !Array.isArray(payload.citations)) {
    res.status(400).json({ detail: 'claims and citations must be arrays' });
    return;
  }
  res.json({ mapped_claims: mapClaimsToCitations(payload.claims, payload.citations) });
});

app.post('/api/open-access-discovery', async (req: Request, res: Response) => {
  const payload = (req.body || {}) as Record<string, unknown>;
  const query = String(payload.doi_or_query || '').trim();
  if (!query) {
    res.status(400).json({ detail: 'doi_or_query is required' });
    return;
  }
  res.json(await discoverOpenAccess(query));
});

app.post('/api/evidence-search', (req: Request, res: Response) => {
  const payload = (req.body || {}) as Record<string, unknown>;
  const claim = String(payload.claim || '').trim();
  const pages = payload.pages;
  if (!claim) {
    res.status(400).json({ detail: 'claim is required' });
    return;
  }
  if (!Array.isArray(pages)) {
    res.status(400).json({ detail: 'pages must be an array of page/text objects' });
    return;
  }
  const limit = Number(payload.limit) || 5;
  res.json(searchEvidence(claim, pages, limit));
});

app.post('/api/reviews', (req: Request, res: Response) => {
  const payload = (req.body || {}) as Record<string, unknown>;
  const documentId = String(payload.document_id || '').trim();
  const claims = payload.claims;
  if (!documentId) {
    res.status(400).json({ detail: 'document_id is required' });
    return;
  }
  if (!Array.isArray(claims)) {
    res.status(400).json({ detail: 'claims must be an array' });
    return;
  }
  const prepared: ClaimResult[] = [];
  claims.forEach((c, idx) => {
    if (!c || typeof c !== 'object') return;
    const item = c as Record<string, unknown>;
    prepared.push({
      claim_id: String(item.claim_id || `claim-${idx + 1}`),
      claim: String(item.claim || item.text || ''),
      citations: Array.isArray(item.citations) ? item.citations : [],
      citation_matches: Array.isArray(item.citation_matches) ? item.citation_matches : [],
      evidence: Array.isArray(item.evidence) ? item.evidence : [],
      verdict: String(item.verdict || 'Unverifiable'),
      verdict_reason: String(item.verdict_reason || ''),
      human_verdict: null,
      human_approved: false,
      human_rejected: false,
      review_comments: [],
    });
  });
  const reviewId = crypto.randomUUID();
  const doc = payload.document && typeof payload.document === 'object' ? (payload.document as Record<string, unknown>) : {};
  res.json(createReview(reviewId, documentId, { claims: prepared, document: doc }));
});

app.get('/api/reviews/:reviewId', (req: Request, res: Response) => {
  const review = getReview(String(req.params.reviewId));
  if (!review) {
    res.status(404).json({ detail: 'Review not found' });
    return;
  }
  res.json(review);
});

app.post('/api/reviews/:reviewId/actions', (req: Request, res: Response) => {
  const payload = (req.body || {}) as Record<string, unknown>;
  const reviewer = String(payload.reviewer || '').trim();
  const action = String(payload.action || '').trim();
  const claimId = payload.claim_id;
  const details = payload.details ?? {};
  if (!reviewer) {
    res.status(400).json({ detail: 'reviewer is required' });
    return;
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    res.status(400).json({ detail: 'details must be an object' });
    return;
  }
  try {
    const review = updateReview(
      String(req.params.reviewId),
      reviewer,
      claimId !== undefined && claimId !== null ? String(claimId) : null,
      action,
      details as Record<string, unknown>,
    );
    if (!review) {
      res.status(404).json({ detail: 'Review not found' });
      return;
    }
    res.json(review);
  } catch (err) {
    const status = (err as Error & { statusCode?: number }).statusCode || 400;
    res.status(status).json({ detail: err instanceof Error ? err.message : 'Bad request' });
  }
});

app.post('/api/reports', (req: Request, res: Response) => {
  const payload = (req.body || {}) as Record<string, unknown>;
  let claims = payload.claims ?? [];
  const document = payload.document ?? {};
  if (!Array.isArray(claims) || !document || typeof document !== 'object' || Array.isArray(document)) {
    res.status(400).json({ detail: 'claims must be an array and document must be an object' });
    return;
  }
  const reviewId = payload.review_id ? String(payload.review_id) : null;
  const review = reviewId ? getReview(reviewId) : null;
  if (review && claims.length === 0) {
    claims = review.payload.claims || [];
  }
  const report = buildReport(document as Record<string, unknown>, claims as Array<Record<string, unknown>>, review);
  res.json({ ...report, markdown: reportMarkdown(report) });
});

app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ detail: 'API endpoint not found' });
});

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ detail: 'File exceeds 20 MB limit' });
    return;
  }
  if (req.path.startsWith('/api')) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ detail: message });
    return;
  }
  next(err);
});

// Setup Vite (dev) / Static dist (production)
const isDev =
  process.env.NODE_ENV !== 'production' &&
  (process.argv.includes('--dev') || process.env.npm_lifecycle_event === 'dev');
if (isDev) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  app.use(vite.middlewares);

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (req.originalUrl.startsWith('/api')) {
      return next();
    }
    try {
      const templatePath = path.resolve(__dirname, 'index.html');
      let template = fs.readFileSync(templatePath, 'utf-8');
      template = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
} else {
  const distDir = path.resolve(__dirname, 'dist');
  app.use(express.static(distDir));
  app.get('/{*splat}', (_req: Request, res: Response) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CiteVerify server listening on http://0.0.0.0:${PORT}`);
});
