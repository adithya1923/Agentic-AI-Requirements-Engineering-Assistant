import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

function requestErrorMessage(error) {
  switch (error.payload?.error?.code) {
    case 'INPUT_NOT_READY': return 'Choose an input that has finished processing and reached READY.';
    case 'LLM_PROVIDER_UNAVAILABLE': return 'The configured Ollama generation provider is unavailable. Check that Ollama is running and the configured generation model is installed.';
    case 'LLM_PROVIDER_ERROR': return 'Ollama could not run the configured generation model. Verify the model name and that it is installed.';
    case 'LLM_INVALID_RESPONSE': return 'Ollama returned an invalid generation response. No candidate requirements were changed.';
    case 'LLM_TIMEOUT': return 'Requirement extraction timed out. Try again or use a faster configured generation model.';
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
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [projectInputs, projectRequirements] = await Promise.all([
        api.projectInputs(projectId),
        api.projectRequirements(projectId),
      ]);
      const readyInputs = projectInputs.filter((input) => input.processingStatus === 'READY');
      setInputs(readyInputs);
      setRequirements(projectRequirements);
      setInputId((current) => readyInputs.some((input) => input.id === current) ? current : readyInputs[0]?.id || '');
    } catch (requestError) {
      setError(requestErrorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function extract() {
    if (!inputId) return;
    setExtracting(true);
    setError('');
    setNotice('');
    try {
      const result = await api.extractRequirements(projectId, inputId);
      setRequirements((current) => [
        ...current.filter((item) => item.sourceInputId !== inputId),
        ...result.requirements,
      ]);
      setNotice(result.requirements.length
        ? `Extracted ${result.requirements.length} candidate ${result.requirements.length === 1 ? 'requirement' : 'requirements'}.`
        : 'Extraction completed. No candidate requirements were supported by this input.');
    } catch (requestError) {
      setError(requestErrorMessage(requestError));
    } finally {
      setExtracting(false);
    }
  }

  return (
    <section className="requirements-section">
      <div className="input-section-heading">
        <div><span className="eyebrow">PHASE 5 · CANDIDATE EXTRACTION</span><h2>Candidate requirements</h2><p>Extract source-supported candidates from a READY project input.</p></div>
      </div>
      <div className="requirements-extract-bar">
        {loading ? <span className="state-message">Loading READY inputs and candidate requirements…</span> : inputs.length ? <>
          <label>READY source input<select value={inputId} onChange={(event) => setInputId(event.target.value)} disabled={extracting}>
            {inputs.map((input) => <option key={input.id} value={input.id}>{input.title} · {input.source}</option>)}
          </select></label>
          <button className="button button-primary" type="button" onClick={extract} disabled={!inputId || extracting}>
            {extracting ? 'Extracting…' : 'Extract Requirements'}
          </button>
        </> : <p className="requirements-empty-input">No READY inputs are available. Add stakeholder text or upload a document above.</p>}
      </div>
      <p className="requirements-boundary-note">Candidates are drafts from source material. Extraction confidence describes fidelity to the source; it is not a regulatory or compliance score.</p>
      {error && <p className="form-error requirements-error" role="alert">{error}</p>}
      {notice && <p className="requirements-notice" role="status">{notice}</p>}
      {!loading && !error && requirements.length === 0 && <div className="input-empty"><strong>No candidate requirements yet</strong><span>Select a READY input and run extraction.</span></div>}
      {!!requirements.length && <div className="requirements-list">{requirements.map((requirement) => <article className="requirement-card" key={requirement.id}>
        <header><span className="eyebrow">{humanize(requirement.requirementType)}</span><span className="requirement-confidence">Extraction confidence · {(requirement.confidence * 100).toFixed(0)}%</span></header>
        <p className="requirement-text">{requirement.requirementText}</p>
        <dl className="requirement-metadata">
          <div><dt>Priority</dt><dd>{requirement.priority ? humanize(requirement.priority) : 'Not stated'}</dd></div>
          <div><dt>Extraction status</dt><dd>{humanize(requirement.extractionStatus)}</dd></div>
          <div><dt>Source input</dt><dd><Link to={`/projects/${projectId}/inputs/${requirement.sourceInputId}`}>{requirement.sourceInput?.title || inputs.find((input) => input.id === requirement.sourceInputId)?.title || requirement.sourceInputId}</Link><small>{requirement.sourceInputId}</small></dd></div>
          <div><dt>Evidence location</dt><dd>Characters {requirement.sourceEvidenceStart}–{requirement.sourceEvidenceEnd}</dd></div>
        </dl>
        <blockquote className="requirement-evidence"><span>Source evidence</span>{requirement.sourceEvidence}</blockquote>
        <div className="requirement-assumptions"><strong>Assumptions</strong>{requirement.assumptions.length ? <ul>{requirement.assumptions.map((assumption, index) => <li key={`${requirement.id}-${index}`}>{assumption}</li>)}</ul> : <span>None recorded</span>}</div>
      </article>)}</div>}
    </section>
  );
}
