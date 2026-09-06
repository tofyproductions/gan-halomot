import type { CapacitorConfig } from '@capacitor/cli';

// Native shell config for the App Store / Play Store builds.
// The bundled web assets under `dist/` are the same Vite output served
// at https://gan-halomot.onrender.com — the native app simply renders
// them inside a WebView and calls that backend over HTTPS
// (see src/api/config.js — VITE_API_BASE_URL must be set at build time).
const config: CapacitorConfig = {
  appId: 'com.ganhahalomot.app',
  appName: 'גן החלומות',
  webDir: 'dist',
  // For dev builds you can flip `server.url` to a local Vite dev server
  // to get hot reload on a real device. Leave commented for store builds
  // so the app ships with the bundled assets.
  // server: { url: 'http://192.168.1.10:5173', cleartext: true },
  ios: {
    contentInset: 'always',
    backgroundColor: '#ffffff',
  },
  android: {
    backgroundColor: '#ffffff',
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: '#ffffff',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#ffffff',
      overlaysWebView: false,
    },
  },
};

export default config;
