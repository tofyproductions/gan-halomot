import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import App from './App';
import RTLProvider from './components/layout/RTLProvider';
import { AuthProvider } from './hooks/useAuth';
import UpdateBanner from './components/shared/UpdateBanner';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <RTLProvider>
        <AuthProvider>
          {/* Above everything, in both apps and on the login screens: a tab or
              an installed app left open runs the build it started with until
              somebody tells it otherwise. */}
          <UpdateBanner />
          <App />
          <ToastContainer position="bottom-left" rtl />
        </AuthProvider>
      </RTLProvider>
    </BrowserRouter>
  </React.StrictMode>
);
