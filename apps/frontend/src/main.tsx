import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/app';
import { installErrorReporting } from '@/lib/report-error';
import './index.css';

installErrorReporting();

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
