import { registerSW } from 'virtual:pwa-register';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { App } from './App.tsx';
// Fonts ship in the bundle: no runtime font request (brief 7.2).
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/source-serif-4/wght.css';
import '@fontsource-variable/source-serif-4/wght-italic.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './tokens.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// A new build is waiting: the user reloads when it suits (not in the middle of a reply).
const updateSW = registerSW({
  onNeedRefresh() {
    toast('Uusi versio saatavilla', {
      duration: Number.POSITIVE_INFINITY,
      action: { label: 'Päivitä', onClick: () => updateSW(true) },
    });
  },
});
