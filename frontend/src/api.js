const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api';

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  } catch {
    throw new Error('Cannot reach the backend. Check that the API is running and try again.');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || 'The request could not be completed.');
  return payload.data ?? payload;
}

export const api = {
  health: () => request('/health'),
  databaseHealth: () => request('/health/db'),
  projects: () => request('/projects'),
  project: (id) => request(`/projects/${encodeURIComponent(id)}`),
  createProject: (project) => request('/projects', {
    method: 'POST',
    body: JSON.stringify(project),
  }),
};
