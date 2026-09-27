const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api';

async function request(path, options = {}) {
  let response;
  try {
    const headers = options.body instanceof FormData
      ? { ...options.headers }
      : { 'Content-Type': 'application/json', ...options.headers };
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers,
    });
  } catch {
    throw new Error('Cannot reach the backend. Check that the API is running and try again.');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || 'The request could not be completed.');
    error.payload = payload;
    throw error;
  }
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
  projectInputs: (projectId) => request(`/projects/${encodeURIComponent(projectId)}/inputs`),
  createTextInput: (projectId, input) => request(`/projects/${encodeURIComponent(projectId)}/inputs`, {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  uploadDocument: (projectId, formData) => request(`/projects/${encodeURIComponent(projectId)}/inputs/documents`, {
    method: 'POST',
    body: formData,
  }),
  input: (id) => request(`/inputs/${encodeURIComponent(id)}`),
  inputContent: (id) => request(`/inputs/${encodeURIComponent(id)}/content`),
  knowledgeDocuments: () => request('/knowledge/documents'),
  knowledgeDocument: (id) => request(`/knowledge/documents/${encodeURIComponent(id)}/chunks`),
  uploadKnowledgeDocument: (formData) => request('/knowledge/documents', { method: 'POST', body: formData }),
  searchKnowledge: (body) => request('/knowledge/search', { method: 'POST', body: JSON.stringify(body) }),
};
