import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const documentTypes = [
  ['EDUCATIONAL_REFERENCE', 'Educational reference'],
  ['BUSINESS_DOMAIN_REFERENCE', 'Business/domain reference'],
  ['ORGANIZATIONAL_POLICY', 'Organizational policy'],
  ['REGULATORY_MATERIAL', 'Regulatory material'],
  ['RISK_CONTROL_REFERENCE', 'Risk/control reference'],
  ['LEGACY_SYSTEM_DOCUMENTATION', 'Legacy system documentation'],
  ['OTHER', 'Other'],
];

const financialDomains = [
  ['GENERAL_FINANCIAL', 'General financial (cross-domain)'],
  ['DIGITAL_BANKING', 'Digital banking'],
  ['LOANS_CREDIT', 'Loans and credit'],
  ['PAYMENTS', 'Payments'],
  ['FRAUD_DETECTION', 'Fraud detection'],
  ['INSURANCE', 'Insurance'],
  ['INVESTMENT', 'Investment'],
  ['REGULATORY_REPORTING', 'Regulatory reporting'],
  ['CUSTOMER_ONBOARDING_KYC', 'Customer onboarding and KYC'],
  ['FINANCIAL_DATA_ANALYTICS', 'Financial data analytics'],
  ['TRADE_FINANCE', 'Trade finance'],
  ['OTHER_FINANCIAL', 'Other financial'],
];

function domainLabel(value) {
  return value ? value.replaceAll('_', ' ').toLowerCase() : 'unclassified';
}

function DocumentRow({ document, onInspect }) {
  return <button className="kb-document-row" type="button" onClick={() => onInspect(document.id)}>
    <span className={`processing-state ${document.processingStatus.toLowerCase()}`}>{document.processingStatus.toLowerCase()}</span>
    <span className="kb-document-copy"><strong>{document.title}</strong><small>{domainLabel(document.financialDomain)} · {document.documentType.replaceAll('_', ' ').toLowerCase()} · {document.source}</small></span>
    <span className="kb-chunk-count">{document.chunkCount} chunks</span>
  </button>;
}

export default function KnowledgeBase() {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [inspected, setInspected] = useState(null);
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState('');
  const [searchDomain, setSearchDomain] = useState('');
  const [results, setResults] = useState(null);
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try { setDocuments(await api.knowledgeDocuments()); }
    catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function inspect(id) {
    setInspected(null);
    try { setInspected(await api.knowledgeDocument(id)); }
    catch (requestError) { setError(requestError.message); }
  }

  async function upload(event) {
    event.preventDefault();
    setUploadError(''); setUploading(true);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const tags = String(form.get('tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean);
    form.set('tags', JSON.stringify(tags));
    try {
      await api.uploadKnowledgeDocument(form);
      formElement.reset();
      await refresh();
    } catch (requestError) {
      setUploadError(requestError.payload?.data?.id
        ? `${requestError.message} Document ${requestError.payload.data.id} was recorded as ${requestError.payload.data.processingStatus}.`
        : requestError.message);
      await refresh();
    } finally { setUploading(false); }
  }

  async function search(event) {
    event.preventDefault();
    setSearching(true); setSearchError(''); setResults(null);
    try { setResults(await api.searchKnowledge({ query, topK: 5,
      ...(searchDomain ? { filters: { financialDomain: searchDomain } } : {}),
    })); }
    catch (requestError) { setSearchError(requestError.message); }
    finally { setSearching(false); }
  }

  return <section className="page-section knowledge-page">
    <div className="page-heading"><div><span className="eyebrow">PHASE 4 · RETRIEVAL FOUNDATION</span><h1>Knowledge Base</h1><p>Index trusted reference documents and inspect matching evidence.</p></div></div>
    <div className="kb-boundary-note"><strong>Evidence retrieval only.</strong> Search returns source-linked chunks. It does not generate requirements or regulatory conclusions.</div>

    <section className="kb-panel"><div className="kb-panel-heading"><div><span className="eyebrow">DOCUMENT MANAGEMENT</span><h2>Add a knowledge document</h2></div><span className="kb-data-label">Sources remain traceable</span></div>
      <form className="kb-upload-form" onSubmit={upload}>
        <label>Title<input name="title" required maxLength="200" /></label>
        <label>Source<input name="source" required maxLength="200" placeholder="Publisher, team, or reference" /></label>
        <label>Document type<select name="documentType" defaultValue="EDUCATIONAL_REFERENCE">{documentTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Financial domain<select name="financialDomain" required defaultValue=""><option value="" disabled>Select a domain</option>{financialDomains.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Jurisdiction<input name="jurisdiction" maxLength="120" placeholder="Optional" /></label>
        <label>Version<input name="version" maxLength="120" placeholder="Optional" /></label>
        <label>Effective date<input name="effectiveDate" type="date" /></label>
        <label>Authority / issuer<input name="authority" maxLength="200" placeholder="Optional" /></label>
        <label>Tags<input name="tags" placeholder="Comma-separated, optional" /></label>
        <label className="kb-file-field">Reference document<input name="file" type="file" required accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" /><small>PDF, DOCX, or TXT · maximum 10 MB</small></label>
        {uploadError && <p className="form-error kb-form-error" role="alert">{uploadError}</p>}
        <button className="button button-primary" disabled={uploading}>{uploading ? 'Processing…' : 'Upload, chunk, and index'} <span aria-hidden="true">→</span></button>
      </form>
    </section>

    <section className="kb-panel"><div className="kb-panel-heading"><div><span className="eyebrow">SEMANTIC SEARCH</span><h2>Retrieve evidence</h2></div></div>
      <form className="kb-search-form" onSubmit={search}><label className="sr-only" htmlFor="kb-query">Natural-language knowledge query</label><input id="kb-query" value={query} onChange={(event) => setQuery(event.target.value)} required maxLength="100000" placeholder="Ask what the references say about a topic…" /><label className="sr-only" htmlFor="kb-search-domain">Filter by financial domain</label><select id="kb-search-domain" value={searchDomain} onChange={(event) => setSearchDomain(event.target.value)}><option value="">All financial domains</option>{financialDomains.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="button button-primary" disabled={searching}>{searching ? 'Searching…' : 'Search'} <span aria-hidden="true">⌕</span></button></form>
      {searchError && <p className="state-error" role="alert">{searchError}</p>}
      {results && <div className="kb-results"><p className="kb-result-count">{results.length} evidence {results.length === 1 ? 'chunk' : 'chunks'} returned · results cite their source documents</p>{results.map((result) => <article className="kb-result" key={result.chunkId}>
        <header><div><strong>{result.document.title}</strong><span>{domainLabel(result.document.financialDomain)} · {result.document.source} · {result.document.documentType.replaceAll('_', ' ').toLowerCase()}</span></div><span className="kb-score">{(result.similarity * 100).toFixed(1)}% match</span></header>
        <p>{result.chunkText}</p><footer>Chunk {result.chunkIndex + 1} · Evidence ID {result.chunkId} · Document ID {result.knowledgeDocumentId}{result.document.jurisdiction ? ` · ${result.document.jurisdiction}` : ''}{result.document.version ? ` · v${result.document.version}` : ''}</footer>
      </article>)}</div>}
    </section>

    <section className="kb-panel"><div className="kb-panel-heading"><div><span className="eyebrow">INDEXED REFERENCES</span><h2>Knowledge documents</h2></div><button className="button button-secondary" type="button" onClick={refresh}>Refresh</button></div>
      {loading ? <p className="state-message">Loading knowledge documents…</p> : error ? <p className="state-error" role="alert">{error}</p> : documents.length ? <div className="kb-document-list">{documents.map((document) => <DocumentRow key={document.id} document={document} onInspect={inspect} />)}</div> : <p className="kb-empty">No knowledge documents have been indexed yet.</p>}
      {inspected && <article className="kb-inspection"><button className="kb-inspection-close" type="button" onClick={() => setInspected(null)}>Close</button><span className="eyebrow">SOURCE DOCUMENT</span><h3>{inspected.document.title}</h3><p>{inspected.document.source} · {inspected.document.processingStatus} · {inspected.chunks.length} chunks</p><dl className="kb-metadata"><div><dt>Financial domain</dt><dd>{domainLabel(inspected.document.financialDomain)}</dd></div><div><dt>Type</dt><dd>{inspected.document.documentType}</dd></div><div><dt>Jurisdiction</dt><dd>{inspected.document.jurisdiction || 'Not specified'}</dd></div><div><dt>Version</dt><dd>{inspected.document.version || 'Not specified'}</dd></div><div><dt>Authority</dt><dd>{inspected.document.authority || 'Not specified'}</dd></div></dl><div className="kb-chunk-list">{inspected.chunks.map((chunk) => <blockquote key={chunk.id}><span>Chunk {chunk.chunkIndex + 1} · {chunk.id} · {domainLabel(inspected.document.financialDomain)}</span>{chunk.chunkText}</blockquote>)}</div></article>}
    </section>
  </section>;
}
