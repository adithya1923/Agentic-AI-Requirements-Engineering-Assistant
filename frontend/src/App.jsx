import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import ProjectForm from './components/ProjectForm.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Projects from './pages/Projects.jsx';
import ProjectDetail from './pages/ProjectDetail.jsx';

function App() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [apiStatus, setApiStatus] = useState('checking');
  const location = useLocation();
  const navigate = useNavigate();

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setProjects(await api.projects());
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
    api.health().then(() => setApiStatus('online')).catch(() => setApiStatus('offline'));
  }, [loadProjects]);

  useEffect(() => { setFormOpen(false); }, [location.pathname]);

  async function createProject(project) {
    const created = await api.createProject(project);
    setProjects((current) => [created, ...current]);
    setFormOpen(false);
    navigate(`/projects/${created.id}`);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/" aria-label="Trade Finance Requirements Assistant home"><span className="brand-symbol"><i /><i /><i /></span><span className="brand-name">Requirements<span>assistant</span></span></Link>
        <nav className="main-nav" aria-label="Main navigation">
          <NavLink end to="/">Overview</NavLink>
          <NavLink to="/projects">Projects</NavLink>
        </nav>
        <div className="topbar-right"><span className={`connection ${apiStatus}`}><i />{apiStatus === 'checking' ? 'Connecting' : apiStatus === 'online' ? 'API connected' : 'API offline'}</span><div className="avatar" title="Local workspace">W</div></div>
      </header>

      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard projects={projects} loading={loading} error={error} onCreate={() => setFormOpen(true)} />} />
          <Route path="/projects" element={<Projects projects={projects} loading={loading} error={error} onCreate={() => setFormOpen(true)} />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="*" element={<section className="page-section"><h1>Page not found</h1><Link to="/">Return to overview</Link></section>} />
        </Routes>
      </main>

      <footer className="footer"><span>Trade Finance Requirements Assistant <span className="footer-dot">·</span> Phase 2 foundation</span><span>Letter of Credit</span></footer>

      {formOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFormOpen(false); }}><ProjectForm onCreate={createProject} onCancel={() => setFormOpen(false)} /></div>}
    </div>
  );
}

export default App;
