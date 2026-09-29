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
  return value.toLowerCase().replaceAll('_', ' ');
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
  const resultRequest = useRef(0);

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

  return (
    <section className="requirements-section">
      <div className="input-section-heading">
        <div><span className="eyebrow">AGENT 1 · REQUIREMENTS INTELLIGENCE</span><h2>Requirements Intelligence</h2><p>Extract and review requirements from a READY input in one bounded model request.</p></div>
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
        {!!intelligence.summary.clarificationQuestions.length && <div className="analysis-questions"><h3>Clarification questions</h3><ul>{intelligence.summary.clarificationQuestions.map((item) => <li key={item.findingId}>{item.question}</li>)}</ul></div>}
        {!!findings.length && <div className="analysis-findings">{findings.map((finding) => <article className="analysis-finding" key={finding.id}><header><div><span className="eyebrow">{humanize(finding.findingType)} · confidence {(finding.confidence * 100).toFixed(0)}%</span><h3>{finding.title}</h3></div><span className="analysis-severity">{humanize(finding.severity)}</span></header><p className="analysis-description">{finding.description}</p>{finding.evidence.map((evidence) => <blockquote className="requirement-evidence" key={`${evidence.requirementId}-${evidence.quote}`}><small>Requirement {evidence.requirementId}</small>{evidence.quote}</blockquote>)}{finding.clarificationQuestion && <p><strong>Question:</strong> {finding.clarificationQuestion}</p>}</article>)}</div>}
        {intelligence.summary.intelligence && <>
          <div className="analysis-counts"><span>Security/privacy: {intelligence.summary.intelligence.securityPrivacy.length}</span><span>Risks: {intelligence.summary.intelligence.risks.length}</span><span>Policy mappings: {intelligence.summary.intelligence.complianceMappings.length}</span><span>Retrieved knowledge sources: {intelligence.summary.intelligence.knowledgeEvidence.length || 'No supporting knowledge-base evidence found.'}</span></div>
          {[...intelligence.summary.intelligence.securityPrivacy,...intelligence.summary.intelligence.risks].map((item,index)=><article className="analysis-finding" key={`${item.title}-${index}`}><header><div><span className="eyebrow">{humanize(item.category || 'RISK')} · confidence {(item.confidence*100).toFixed(0)}%</span><h3>{item.title}</h3></div></header><p className="analysis-description">{item.observation}</p>{item.evidenceQuote&&<blockquote className="requirement-evidence">{item.evidenceQuote}</blockquote>}</article>)}
        </>}
        {!!intelligence.summary.intelligence?.complianceMappings.length && <div className="analysis-findings">{intelligence.summary.intelligence.complianceMappings.map((mapping, index) => <article className="analysis-finding" key={index}><h3>{mapping.title}</h3><p>{mapping.observation}</p>{mapping.citation && <blockquote className="requirement-evidence"><strong>{mapping.citation.title}</strong> · {mapping.citation.source}<br />{mapping.evidenceQuote}</blockquote>}<small>Confidence {(mapping.confidence * 100).toFixed(0)}% · Demo/non-authoritative unless source metadata says otherwise</small></article>)}</div>}
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
        <div className="requirement-assumptions"><strong>Assumptions</strong>{requirement.assumptions.length ? <ul>{requirement.assumptions.map((assumption, index) => <li key={`${requirement.id}-${index}`}>{assumption}</li>)}</ul> : <span>None recorded</span>}</div>
      </article>)}</div>}
    </section>
  );
}
