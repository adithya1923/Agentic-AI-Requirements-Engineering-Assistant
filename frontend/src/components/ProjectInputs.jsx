import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const inputTypes = [
  ['STAKEHOLDER_STATEMENT', 'Stakeholder statement'],
  ['MEETING_NOTES', 'Meeting notes'],
  ['INTERVIEW_TRANSCRIPT', 'Interview transcript'],
  ['REQUIREMENT_NOTES', 'Requirement notes'],
  ['BUSINESS_CONTEXT', 'Business context'],
  ['PROCESS_DESCRIPTION', 'Process description'],
  ['OTHER_TEXT', 'Other text'],
];

const labels = Object.fromEntries(inputTypes);

function InputCard({ input, projectId }) {
  const typeLabel = input.inputType === 'DOCUMENT' ? 'Uploaded document' : labels[input.inputType] || input.inputType;
  return (
    <Link className="input-card" to={`/projects/${projectId}/inputs/${input.id}`}>
      <span className="input-file-mark" aria-hidden="true">{input.inputType === 'DOCUMENT' ? 'DOC' : 'TXT'}</span>
      <span className="input-card-copy">
        <strong>{input.title}</strong>
        <span>{typeLabel} · {input.source}</span>
        {input.originalFilename && <small>{input.originalFilename}</small>}
      </span>
      <span className={`processing-state ${input.processingStatus.toLowerCase()}`}>{input.processingStatus.toLowerCase()}</span>
      <span className="input-open-arrow" aria-hidden="true">↗</span>
    </Link>
  );
}

function AddInputForm({ mode, projectId, onCancel, onSaved }) {
  const [title, setTitle] = useState('');
  const [source, setSource] = useState('');
  const [inputType, setInputType] = useState('STAKEHOLDER_STATEMENT');
  const [content, setContent] = useState('');
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      if (mode === 'text') {
        await api.createTextInput(projectId, { title, source, inputType, content });
      } else {
        const formData = new FormData();
        formData.append('title', title);
        formData.append('source', source);
        if (file) formData.append('file', file);
        await api.uploadDocument(projectId, formData);
      }
      await onSaved();
    } catch (requestError) {
      const inputId = requestError.payload?.data?.id;
      setError(inputId ? `${requestError.message} Input record ${inputId} is marked FAILED.` : requestError.message);
      if (inputId) await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="input-form" onSubmit={submit}>
      <div className="input-form-heading"><h3>{mode === 'text' ? 'Add stakeholder text' : 'Upload a document'}</h3><button className="icon-button" type="button" onClick={onCancel} aria-label="Cancel">×</button></div>
      <div className="input-form-grid">
        <label>Title<input required maxLength="200" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Give this source a clear name" /></label>
        <label>Source / origin<input required maxLength="200" value={source} onChange={(event) => setSource(event.target.value)} placeholder="e.g. Trade finance operations interview" /></label>
        {mode === 'text' ? <>
          <label>Input type<select value={inputType} onChange={(event) => setInputType(event.target.value)}>{inputTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="input-content-label">Submitted content<textarea required maxLength="100000" rows="7" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Enter stakeholder notes, statements, or process context." /></label>
        </> : <label className="input-content-label">Document file<input required type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" onChange={(event) => setFile(event.target.files?.[0] || null)} /><small>PDF, DOCX, or TXT · maximum 10 MB</small></label>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? 'Saving…' : mode === 'text' ? 'Save text input' : 'Upload and extract'} <span aria-hidden="true">→</span></button></div>
    </form>
  );
}

export default function ProjectInputs({ projectId }) {
  const [inputs, setInputs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formMode, setFormMode] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setInputs(await api.projectInputs(projectId));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function completeSave() {
    setFormMode(null);
    await refresh();
  }

  return (
    <section className="project-inputs">
      <div className="input-section-heading"><div><span className="eyebrow">SOURCE MATERIAL</span><h2>Inputs &amp; documents</h2><p>Stakeholder information and source files linked to this project.</p></div><div className="input-add-actions"><button className="button button-secondary" onClick={() => setFormMode('text')}>＋ Add text</button><button className="button button-primary" onClick={() => setFormMode('document')}>＋ Upload document</button></div></div>
      {formMode && <AddInputForm mode={formMode} projectId={projectId} onCancel={() => setFormMode(null)} onSaved={completeSave} />}
      {loading ? <p className="state-message">Loading project inputs…</p> : error ? <p className="state-error" role="alert">{error}</p> : inputs.length ? <div className="input-list">{inputs.map((input) => <InputCard key={input.id} input={input} projectId={projectId} />)}</div> : <div className="input-empty"><span className="empty-icon">▤</span><strong>No source inputs yet</strong><span>Add stakeholder text or upload a PDF, DOCX, or TXT file.</span></div>}
    </section>
  );
}
