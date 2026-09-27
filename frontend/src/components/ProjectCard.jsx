import { Link } from 'react-router-dom';
import StatusPill from './StatusPill.jsx';

export default function ProjectCard({ project }) {
  return (
    <Link className="project-card" to={`/projects/${project.id}`}>
      <div className="card-topline">
        <span className="project-icon" aria-hidden="true">LC</span>
        <StatusPill>{project.status.toLowerCase()}</StatusPill>
      </div>
      <h3>{project.name}</h3>
      <p>{project.description || 'No description added yet.'}</p>
      <div className="card-meta">
        <span>{project.selectedDomain}</span>
        <span>Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
      </div>
      <span className="card-open">Open project <span aria-hidden="true">↗</span></span>
    </Link>
  );
}
