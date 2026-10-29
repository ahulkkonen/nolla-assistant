import { registerSW } from 'virtual:pwa-register';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
// Fonts ship in the bundle: no runtime font request (brief 7.2).
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/source-serif-4/wght.css';
import '@fontsource-variable/source-serif-4/wght-italic.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './tokens.css';
import { reloadWhenIdle } from './update.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// A new build is waiting: it loads at the first moment a reload loses nothing.
const updateSW = registerSW({ onNeedRefresh: () => reloadWhenIdle(() => void updateSW(true)) });
