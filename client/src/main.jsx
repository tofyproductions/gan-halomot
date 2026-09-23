import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import App from './App';
import RTLProvider from './components/layout/RTLProvider';
import { AuthProvider } from './hooks/useAuth';
import { UiVersionProvider } from './hooks/useUiVersion';
import UpdateBanner from './components/shared/UpdateBanner';

// תמונות שממתינות בתור ממשיכות לעלות ברגע שיש רשת ושהאפליקציה פתוחה — גם
// אם היא נסגרה באמצע ההעלאה אתמול, כי התור שמור על המכשיר.
//
// בייבוא עצל ומושהה: זה נוגע רק למי שמעלה תמונות, והוא לא צריך לשבת על
// המסלול הקריטי של הורה שבא לראות תשלום. `requestIdleCallback` דוחה אותו עד
// שהמסך הראשון סיים לצייר.
const resumeUploads = () => import('./utils/uploadQueue')
  .then(m => m.startAutoResume())
  .catch(() => {});
if (typeof requestIdleCallback === 'function') requestIdleCallback(resumeUploads);
else setTimeout(resumeUploads, 3000);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      {/*
        * AuthProvider is OUTSIDE the theme now, and the order is the point.
        *
        * Which theme to render is a property of the logged-in person — she may
        * be on the classic interface or the new one — so the theme cannot be
        * chosen until the user is known. AuthProvider renders no UI of its
        * own (no MUI import anywhere in it), so hoisting it above the theme
        * costs nothing and is what lets RTLProvider ask.
        */}
      <AuthProvider>
        <UiVersionProvider>
          <RTLProvider>
            {/* Above everything, in both apps and on the login screens: a tab
                or an installed app left open runs the build it started with
                until somebody tells it otherwise. */}
            <UpdateBanner />
            <App />
            <ToastContainer position="bottom-left" rtl />
          </RTLProvider>
        </UiVersionProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
