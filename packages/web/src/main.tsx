import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter-tight';
import '@fontsource-variable/jetbrains-mono';
import './styles/design.css';
import './styles/page.css';
import './styles/fonts.css';
import { IconSprite } from './ds/icon';
import { ToastProvider } from './ds/toast';
import { initAuthToken } from './lib/api';
import { ResumeUploadView } from './resume-upload-view';

initAuthToken();

const root = document.getElementById('root');
if (!root) throw new Error('The page has no #root element.');

createRoot(root).render(
  <StrictMode>
    <IconSprite />
    <ToastProvider>
      <ResumeUploadView />
    </ToastProvider>
  </StrictMode>,
);
