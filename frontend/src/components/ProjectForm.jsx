import { useState } from 'react';

const initialDomain = 'General Financial';

export default function ProjectForm({ onCreate, onCancel }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedDomain, setSelectedDomain] = useState(initialDomain);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!name.trim()) {
      setError('Enter a project name to continue.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onCreate({ name: name.trim(), description: description.trim(), selectedDomain });
    } catch (createError) {
      setError(createError.message);
      setSaving(false);
    }
  }

  return (
    <form className="project-form" onSubmit={handleSubmit}>
      <div className="form-heading">
        <div><span className="eyebrow">NEW WORKSPACE</span><h2>Create a project</h2></div>
        <button className="icon-button" type="button" onClick={onCancel} aria-label="Close form">×</button>
      </div>
      <label htmlFor="project-name">Project name <span className="required">*</span></label>
      <input id="project-name" autoFocus maxLength="160" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. LC document review modernization" />
      <label htmlFor="project-domain">Selected domain</label>
      <input id="project-domain" maxLength="120" value={selectedDomain} onChange={(event) => setSelectedDomain(event.target.value)} />
      <label htmlFor="project-description">Description <span className="optional">Optional</span></label>
      <textarea id="project-description" maxLength="4000" rows="4" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe the software project and the needs it should address." />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button>
        <button className="button button-primary" disabled={saving}>{saving ? 'Creating…' : 'Create project'} <span aria-hidden="true">→</span></button>
      </div>
    </form>
  );
}
