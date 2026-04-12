import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// Simple error logging (no auth redirect - open access like original GAS app)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('API Error:', error.response?.status, error.response?.data?.error || error.message);
    return Promise.reject(error);
  }
);

export default api;
