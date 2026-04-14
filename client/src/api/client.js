import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// Automatically include branch parameter in GET requests (unless already set)
api.interceptors.request.use((config) => {
  const branch = localStorage.getItem('selectedBranch');
  if (branch && config.method === 'get' && !config.params?.branch) {
    config.params = { ...config.params, branch };
  }
  return config;
});

// Simple error logging
api.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('API Error:', error.response?.status, error.response?.data?.error || error.message);
    return Promise.reject(error);
  }
);

export default api;
