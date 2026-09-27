import ProjectCard from '../components/ProjectCard.jsx';

export default function Projects({ projects, loading, error, onCreate }) {
  return (
    <section className="page-section">
      <div className="section-heading page-heading"><div><span className="eyebrow">WORKSPACE</span><h1>Projects</h1><p>Keep your requirements engineering work organized by project.</p></div><button className="button button-primary" onClick={onCreate}>＋ New project</button></div>
      {loading ? <p className="state-message">Loading projects from your workspace…</p> : error ? <p className="state-error" role="alert">{error}</p> : projects.length ? <div className="project-grid">{projects.map((project) => <ProjectCard key={project.id} project={project} />)}</div> : <div className="empty-state"><span className="empty-icon">▧</span><h2>Your project space is ready</h2><p>Create a project to start capturing its scope and requirements context.</p><button className="button button-primary" onClick={onCreate}>Create your first project</button></div>}
    </section>
  );
}
