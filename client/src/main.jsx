import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import App from './App';
import RTLProvider from './components/layout/RTLProvider';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <RTLProvider>
        <App />
        <ToastContainer position="bottom-left" rtl />
      </RTLProvider>
    </BrowserRouter>
  </React.StrictMode>
);
