import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

function requestErrorMessage(error) {
  switch (error.payload?.error?.code) {
    case 'INPUT_NOT_READY': return 'Choose an input that has finished processing and reached READY.';
    case 'LLM_PROVIDER_UNAVAILABLE': return error.message || 'The configured generation provider is unavailable.';
    case 'LLM_PROVIDER_ERROR': return error.message || 'The configured generation provider could not complete the request.';
    case 'LLM_RATE_LIMITED': return 'LLM provider quota exceeded. Please retry later.';
    case 'LLM_ALL_PROVIDERS_FAILED': return 'LLM provider is temporarily unavailable.';
    case 'LLM_INVALID_RESPONSE': return error.message || 'The configured generation provider returned an invalid response. No candidate requirements were changed.';
    case 'LLM_TIMEOUT': return 'Requirement extraction timed out. Try again or use a faster configured generation model.';
    case 'INTELLIGENCE_INPUT_TOO_LARGE':
    case 'INTELLIGENCE_CONTEXT_TOO_LARGE': return error.message;
    case 'INVALID_MODEL_OUTPUT': return 'The model response did not match the required structured format or source evidence. No candidate requirements were changed.';
    case 'SOURCE_INPUT_EMPTY': return 'This input has no extracted or submitted text to analyze.';
    case 'DATABASE_UNAVAILABLE': return 'The database is unavailable. Candidate requirements could not be loaded or saved.';
    case 'DATABASE_ERROR': return 'The database operation failed. Candidate requirements could not be loaded or saved.';
    case 'VALIDATION_ERROR': return error.message;
    default: return error.message;
  }
}

function humanize(value) {
  return String(value ?? 'unspecified').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replaceAll('_', ' ');
}

export default function ProjectRequirements({ projectId }) {
  const [inputs, setInputs] = useState([]);
  const [requirements, setRequirements] = useState([]);
  const [inputId, setInputId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingResult, setLoadingResult] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [intelligence, setIntelligence] = useState(null);
  const [findings, setFindings] = useState([]);
  const [sdlc, setSdlc] = useState(null);
  const [sdlcBusy, setSdlcBusy] = useState(false);
  const resultRequest = useRef(0);
  const clarificationQuestions = Array.isArray(intelligence?.summary?.clarificationQuestions) ? intelligence.summary.clarificationQuestions : [];
  const intelligenceData = intelligence?.summary?.intelligence || {};
  const knowledgeEvidence = Array.isArray(intelligenceData.knowledgeEvidence) ? intelligenceData.knowledgeEvidence : [];
  const securityPrivacy = Array.isArray(intelligenceData.securityPrivacy) ? intelligenceData.securityPrivacy : [];
  const risks = Array.isArray(intelligenceData.risks) ? intelligenceData.risks : [];
  const complianceMappings = Array.isArray(intelligenceData.complianceMappings) ? intelligenceData.complianceMappings : [];

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    setInputId('');
    setRequirements([]);
    setIntelligence(null);
    setFindings([]);
    try {
      const projectInputs = await api.projectInputs(projectId);
      const readyInputs = projectInputs.filter((input) => input.processingStatus === 'READY');
      setInputs(readyInputs);
      setInputId(readyInputs[0]?.id || '');
    } catch (requestError) {
      setError(requestErrorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => { api.projectSdlc(projectId).then(setSdlc).catch(() => setSdlc(null)); }, [projectId]);

  useEffect(() => {
    const requestId=++resultRequest.current;
    setRequirements([]);
    setIntelligence(null);
    setFindings([]);
    setError('');
    if(!inputId){setLoadingResult(false);return;}
    setLoadingResult(true);
    Promise.all([api.projectRequirements(projectId,inputId),api.projectRequirementAnalysis(projectId,inputId)])
      .then(([sourceRequirements,sourceAnalysis])=>{
        if(requestId!==resultRequest.current)return;
        const validRequirements=sourceRequirements.filter((requirement)=>requirement.sourceInputId===inputId);
        const resultMatches=sourceAnalysis.sourceInputId===inputId&&(!sourceAnalysis.analysis||sourceAnalysis.analysis.sourceInputId===inputId);
        setRequirements(validRequirements);
        if(resultMatches){
          const validIds=new Set(validRequirements.map((requirement)=>requirement.id));
          const validFindings=sourceAnalysis.findings.filter((finding)=>finding.requirementIds.length>0&&finding.requirementIds.every((id)=>validIds.has(id)));
          setIntelligence(validFindings.length===sourceAnalysis.findings.length?sourceAnalysis.analysis:null);
          setFindings(validFindings.length===sourceAnalysis.findings.length?validFindings:[]);
        }
      })
      .catch((requestError)=>{if(requestId===resultRequest.current)setError(requestErrorMessage(requestError));})
      .finally(()=>{if(requestId===resultRequest.current)setLoadingResult(false);});
  },[projectId,inputId]);

  async function extract() {
    if (!inputId) return;
    setExtracting(true);
    setError('');
    setNotice('');
    try {
      const result = await api.runRequirementsIntelligence(projectId, inputId);
      if(result.sourceInputId!==inputId||result.requirements.some((requirement)=>requirement.sourceInputId!==inputId))throw new Error('The returned Requirements Intelligence result does not match the selected source input.');
      const requirementIds=new Set(result.requirements.map((requirement)=>requirement.id));
      if(result.findings.some((finding)=>finding.requirementIds.some((id)=>!requirementIds.has(id))))throw new Error('The returned findings do not belong to the selected source input.');
      setRequirements(result.requirements);
      setIntelligence(result.analysis?.sourceInputId===inputId?result.analysis:null);
      setFindings(result.analysis?.sourceInputId===inputId?result.findings:[]);
      setNotice(`Requirements Intelligence completed with ${result.analysis.provider} · ${result.analysis.modelName}. ${result.requirements.length} source-linked requirements saved.`);
    } catch (requestError) {
      setError(requestErrorMessage(requestError));
    } finally {
      setExtracting(false);
    }
  }

  async function reviewRequirement(requirement, status) {
    try {
      const requirementText = status === 'MODIFIED' ? window.prompt('Edit the requirement wording. Original source evidence is preserved.', requirement.requirementText) : undefined;
      if (status === 'MODIFIED' && (requirementText === null || !requirementText.trim())) return;
      const saved = await api.reviewRequirement(requirement.id, { status, ...(requirementText !== undefined ? { requirementText } : {}) });
      setRequirements((current) => current.map((item) => item.id === requirement.id ? { ...item, reviewStatus: status, ...(status === 'MODIFIED' ? { requirementText: saved.requirementText } : {}) } : item));
      setSdlc(await api.projectSdlc(projectId).catch(() => null));
    } catch (requestError) { setError(requestError.message); }
  }

  async function runSdlc() {
    setSdlcBusy(true); setError('');
    try { setSdlc(await api.runSdlc(projectId)); }
    catch (requestError) { setError(requestError.message); }
    finally { setSdlcBusy(false); }
  }

  async function reviewSdlc(status) {
    try { setSdlc(await api.reviewSdlc(sdlc.id, { status })); }
    catch (requestError) { setError(requestError.message); }
  }

  return (
    <section className="requirements-section">
      <div className="input-section-heading">
        <div><span className="eyebrow">AGENT 1 · REQUIREMENTS INTELLIGENCE</span><h2>Requirements Intelligence</h2><p>Run structured extraction, quality analysis, classification, and knowledge retrieval for a READY input.</p></div>
      </div>
      <div className="requirements-extract-bar">
        {loading ? <span className="state-message">Loading READY inputs and candidate requirements…</span> : inputs.length ? <>
          <label>READY source input<select value={inputId} onChange={(event) => {setInputId(event.target.value);setRequirements([]);setIntelligence(null);setFindings([]);setNotice('');}} disabled={extracting}>
            {inputs.map((input) => <option key={input.id} value={input.id}>{input.title} · {input.source}</option>)}
          </select></label>
          <button className="button button-primary" type="button" onClick={extract} disabled={!inputId || extracting}>
            {extracting ? 'Running…' : 'Run Requirements Intelligence'}
          </button>
        </> : <p className="requirements-empty-input">No READY inputs are available. Add stakeholder text or upload a document above.</p>}
      </div>
      <p className="requirements-boundary-note">AI output is advisory. Confidence measures extraction/observation confidence, not regulatory compliance. Demo knowledge entries are non-authoritative.</p>
      {error && <p className="form-error requirements-error" role="alert">{error}</p>}
      {notice && <p className="requirements-notice" role="status">{notice}</p>}
      {!loading && !loadingResult && !error && requirements.length === 0 && <div className="input-empty"><strong>No candidate requirements yet</strong><span>Select a READY input and run Requirements Intelligence.</span></div>}
      {loadingResult&&<p className="state-message">Loading results for the selected source…</p>}
      {intelligence && intelligence.sourceInputId===inputId && <section className="analysis-section" aria-label="Requirements Intelligence results">
        <h3>Analysis · {intelligence.requirementCount} requirements · {intelligence.findingCount} findings</h3>
        {!!clarificationQuestions.length && <div className="analysis-questions"><h3>Clarification questions</h3><ul>{clarificationQuestions.map((item) => <li key={item.findingId}>{item.question}</li>)}</ul></div>}
        {!!findings.length && <div className="analysis-findings">{findings.map((finding) => <article className="analysis-finding" key={finding.id}><header><div><span className="eyebrow">{humanize(finding.findingType)} · confidence {(finding.confidence * 100).toFixed(0)}%</span><h3>{finding.title}</h3></div><span className="analysis-severity">{humanize(finding.severity)}</span></header><p className="analysis-description">{finding.description}</p>{finding.evidence.map((evidence) => <blockquote className="requirement-evidence" key={`${evidence.requirementId}-${evidence.quote}`}><small>Requirement {evidence.requirementId}</small>{evidence.quote}</blockquote>)}{finding.clarificationQuestion && <p><strong>Question:</strong> {finding.clarificationQuestion}</p>}</article>)}</div>}
        {intelligence.summary.intelligence && <>
          <div className="analysis-counts"><span>Retrieved knowledge sources: {knowledgeEvidence.length || 'No supporting knowledge-base evidence found.'}</span></div>
          {!!knowledgeEvidence.length && <div className="analysis-findings">{knowledgeEvidence.map((item) => <article className="analysis-finding" key={item.chunkId}><header><div><span className="eyebrow">RETRIEVED KNOWLEDGE · separate from source requirements</span><h3>{item.title}</h3></div><span className="analysis-severity">Similarity {((item.similarity || 0) * 100).toFixed(0)}%</span></header><p>{item.text}</p><small>Document {item.documentId} · {item.source} · Authority metadata: {item.authority || 'Unspecified'} · {item.documentType || 'Unspecified type'}</small></article>)}</div>}
          {[...securityPrivacy,...risks].filter((item)=>!findings.some((finding)=>finding.title===item.title&&finding.description===item.observation)).map((item,index)=><article className="analysis-finding" key={`${item.title}-${index}`}><header><div><span className="eyebrow">{humanize(item.category || 'RISK')} · confidence {((item.confidence || 0)*100).toFixed(0)}%</span><h3>{item.title}</h3></div></header><p className="analysis-description">{item.observation}</p>{item.evidenceQuote&&<blockquote className="requirement-evidence">{item.evidenceQuote}</blockquote>}</article>)}
        </>}
          {!!complianceMappings.filter((mapping)=>!findings.some((finding)=>finding.title===mapping.title&&finding.description===mapping.observation)).length && <div className="analysis-findings">{complianceMappings.filter((mapping)=>!findings.some((finding)=>finding.title===mapping.title&&finding.description===mapping.observation)).map((mapping, index) => <article className="analysis-finding" key={index}><h3>{mapping.title}</h3><p>{mapping.observation}</p>{mapping.citation && <blockquote className="requirement-evidence"><strong>{mapping.citation.title}</strong> · {mapping.citation.source}<br />{mapping.evidenceQuote}</blockquote>}<small>Confidence {((mapping.confidence || 0)*100).toFixed(0)}% · Authority metadata: {mapping.citation?.authority || 'Unspecified'} · Retrieved material does not establish a binding conclusion.</small></article>)}</div>}
      </section>}
      {!!requirements.length && <div className="requirements-list">{requirements.filter((requirement)=>requirement.sourceInputId===inputId).map((requirement) => <article className="requirement-card" key={requirement.id}>
        <header><span className="eyebrow">{humanize(requirement.requirementType)}</span><span className="requirement-confidence">Extraction confidence · {(requirement.confidence * 100).toFixed(0)}%</span></header>
        <p className="requirement-text">{requirement.requirementText}</p>
        <dl className="requirement-metadata">
          <div><dt>Priority</dt><dd>{requirement.priority ? humanize(requirement.priority) : 'Not stated'}</dd></div>
          <div><dt>Extraction status</dt><dd>{humanize(requirement.extractionStatus)}</dd></div>
          <div><dt>Provider / model</dt><dd>{requirement.provider} · {requirement.modelName}</dd></div>
          <div><dt>Source input</dt><dd><Link to={`/projects/${projectId}/inputs/${requirement.sourceInputId}`}>{requirement.sourceInput?.title || inputs.find((input) => input.id === requirement.sourceInputId)?.title || requirement.sourceInputId}</Link><small>{requirement.sourceInputId}</small></dd></div>
          <div><dt>Evidence location</dt><dd>Characters {requirement.sourceEvidenceStart}–{requirement.sourceEvidenceEnd}</dd></div>
        </dl>
        <blockquote className="requirement-evidence"><span>Source evidence</span>{requirement.sourceEvidence}</blockquote>
        <div className="requirement-assumptions"><strong>Assumptions</strong>{requirement.assumptions?.length ? <ul>{requirement.assumptions.map((assumption, index) => <li key={`${requirement.id}-${index}`}>{assumption}</li>)}</ul> : <span>None recorded</span>}</div>
        <div className="review-controls"><strong>Human review · {humanize(requirement.reviewStatus || 'DRAFT')}</strong><button type="button" onClick={() => reviewRequirement(requirement, 'REVIEWED')}>Mark reviewed</button><button type="button" onClick={() => reviewRequirement(requirement, 'APPROVED')}>Approve</button><button type="button" onClick={() => reviewRequirement(requirement, 'REJECTED')}>Reject</button><button type="button" onClick={() => reviewRequirement(requirement, 'MODIFIED')}>Modify</button></div>
      </article>)}</div>}
      {!!requirements.length && <section className="analysis-section sdlc-section"><span className="eyebrow">AGENT 2 · SDLC + DOCUMENTATION</span><h3>Project delivery recommendation</h3><p>Approve source-linked requirements first. Deterministic factor scoring ranks delivery approaches; the configured LLM selects relevant computed factors for the explanation. Generated artefacts remain drafts until reviewed.</p><button className="button button-primary" type="button" onClick={runSdlc} disabled={sdlcBusy || !requirements.some((item) => item.reviewStatus === 'APPROVED')}>{sdlcBusy ? 'Analyzing…' : 'Run SDLC + documentation analysis'}</button>
        {sdlc?.isStale ? <p className="state-message" role="status">The saved SDLC analysis is stale because a requirement changed. Run the analysis again to use the current approved requirements.</p> : sdlc && <div className="sdlc-result"><h4>{humanize(sdlc.recommendation)} · {humanize(sdlc.status)}</h4><p>{sdlc.explanation}</p><h4>Ranking</h4><ol>{(sdlc.ranking || []).map((item) => <li key={item.method}>{humanize(item.method)} · score {item.score}</li>)}</ol><h4>Scored factors</h4><dl className="requirement-metadata">{Object.entries(sdlc.factors || {}).map(([factor,value]) => <div key={factor}><dt>{humanize(factor)}</dt><dd>{value}/5</dd></div>)}</dl><h4>Workflow</h4><ol>{(sdlc.workflow || []).map((item) => <li key={item.order}>{item.activity}</li>)}</ol><h4>Generated artefacts</h4>{(sdlc.artefacts || []).map((item) => <details key={item.type}><summary>{item.title} · {humanize(item.status)}</summary><pre>{item.content}</pre></details>)}<div className="review-controls"><button type="button" onClick={() => reviewSdlc('REVIEWED')}>Mark reviewed</button><button type="button" onClick={() => reviewSdlc('APPROVED')}>Approve recommendation and artefacts</button><button type="button" onClick={() => reviewSdlc('REJECTED')}>Reject</button></div></div>}
      </section>}
    </section>
  );
}
