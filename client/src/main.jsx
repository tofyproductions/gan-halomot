import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import App from './App';
import RTLProvider from './components/layout/RTLProvider';
import { AuthProvider } from './hooks/useAuth';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <RTLProvider>
        <AuthProvider>
          <App />
          <ToastContainer position="bottom-left" rtl />
        </AuthProvider>
      </RTLProvider>
    </BrowserRouter>
  </React.StrictMode>
);
