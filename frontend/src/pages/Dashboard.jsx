import { Link } from 'react-router-dom';
import ProjectCard from '../components/ProjectCard.jsx';

export default function Dashboard({ projects, loading, error, onCreate }) {
  const activeCount = projects.filter((project) => project.status === 'ACTIVE').length;
  return (
    <>
      <section className="welcome-panel">
        <div className="welcome-copy">
          <span className="eyebrow eyebrow-light">YOUR REQUIREMENTS WORKSPACE</span>
          <h1>Make complex project needs<br />clear and actionable.</h1>
          <p>Organize requirements engineering projects for Trade Finance and Letter of Credit systems.</p>
          <button className="button button-light" onClick={onCreate}>Start a project <span aria-hidden="true">→</span></button>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="art-document"><div className="doc-mark">LC</div><i /><i /><i /><b>PROJECT BRIEF</b></div>
          <span className="art-chip chip-req">Requirements</span><span className="art-chip chip-flow">Workflow</span><span className="art-chip chip-check">✓ &nbsp; Human reviewed</span>
        </div>
      </section>

      <section className="stats-grid" aria-label="Project overview">
        <article className="stat-card"><span className="stat-icon stat-icon-green">▧</span><div><strong>{projects.length}</strong><span>Total projects</span></div><span className="stat-foot">In your workspace</span></article>
        <article className="stat-card"><span className="stat-icon stat-icon-blue">◷</span><div><strong>{activeCount}</strong><span>Active projects</span></div><span className="stat-foot">Currently in progress</span></article>
        <article className="stat-card"><span className="stat-icon stat-icon-amber">✳</span><div><strong>LC</strong><span>Selected domain</span></div><span className="stat-foot">Trade Finance</span></article>
      </section>

      <section className="section-block">
        <div className="section-heading"><div><span className="eyebrow">PROJECT SPACE</span><h2>Recent projects</h2></div><Link className="text-link" to="/projects">View all projects <span aria-hidden="true">→</span></Link></div>
        {loading ? <p className="state-message">Loading projects from your workspace…</p> : error ? <p className="state-error" role="alert">{error}</p> : projects.length ? <div className="project-grid">{projects.slice(0, 3).map((project) => <ProjectCard key={project.id} project={project} />)}</div> : <p className="state-message">No projects yet. Start one to begin organizing its requirements work.</p>}
      </section>
      <div className="advisory-note"><span className="note-icon">i</span><p><strong>Designed for human-led requirements work.</strong> This foundation helps teams organize project context. It does not process banking transactions or make compliance decisions.</p></div>
    </>
  );
}
