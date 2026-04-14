import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// Add auth token + branch param to requests
api.interceptors.request.use((config) => {
  // Auth token
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  // Auto-add branch for GET requests (unless already set)
  const branch = localStorage.getItem('selectedBranch');
  if (branch && config.method === 'get' && !config.params?.branch) {
    config.params = { ...config.params, branch };
  }

  return config;
});

// Error handling + 401 redirect
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Don't redirect if already on login page or login request
      const isLoginRequest = error.config?.url?.includes('/auth/');
      if (!isLoginRequest && window.location.pathname !== '/login') {
        localStorage.removeItem('token');
        window.location.href = '/login';
      }
    }
    console.error('API Error:', error.response?.status, error.response?.data?.error || error.message);
    return Promise.reject(error);
  }
);

export default api;
