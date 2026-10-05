import { Link, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import StatusPill from '../components/StatusPill.jsx';
import { api } from '../api.js';
import ProjectInputs from '../components/ProjectInputs.jsx';
import ProjectRequirements from '../components/ProjectRequirements.jsx';

export default function ProjectDetail() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    api.project(projectId).then((result) => { if (current) setProject(result); })
      .catch((requestError) => { if (current) setError(requestError.message); });
    return () => { current = false; };
  }, [projectId]);

  if (error) return <section className="page-section"><Link className="back-link" to="/projects">← All projects</Link><p className="state-error" role="alert">{error}</p></section>;
  if (!project) return <section className="page-section"><p className="state-message">Loading project…</p></section>;

  return (
    <section className="page-section detail-page">
      <Link className="back-link" to="/projects">← All projects</Link>
      <div className="detail-header"><div className="detail-icon">FS</div><div><span className="eyebrow">PROJECT OVERVIEW</span><h1>{project.name || 'Untitled project'}</h1><p>{project.selectedDomain || 'General Financial'}</p></div><StatusPill>{(project.status || 'draft').toLowerCase()}</StatusPill></div>
      <div className="detail-grid">
        <article className="detail-card detail-main"><span className="eyebrow">PROJECT BRIEF</span><h2>Project context</h2><p>{project.description || 'No project description has been added yet.'}</p></article>
        <article className="detail-card"><span className="eyebrow">OWNERSHIP</span><h2>{project.ownerName || 'Unassigned'}</h2><p>Project owner</p></article>
        <article className="detail-card"><span className="eyebrow">CREATED</span><h2>{formatDate(project.createdAt)}</h2><p>Last updated {formatDate(project.updatedAt)}</p></article>
      </div>
      <div className="advisory-note"><span className="note-icon">i</span><p><strong>Requirements Intelligence.</strong> Structured model steps extract source-linked candidates, analyze quality and ambiguity, classify requirements, and retrieve related knowledge-base evidence. Results are advisory; original input text is preserved.</p></div>
      <ProjectInputs projectId={projectId} />
      <ProjectRequirements projectId={projectId} />
    </section>
  );
}

function formatDate(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleDateString();
}
