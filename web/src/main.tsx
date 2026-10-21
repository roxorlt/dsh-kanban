import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bridge } from './bridge';

import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/board.css';
import './styles/list.css';
import './styles/drawer.css';
import './styles/modal.css';
import './styles/responsive.css';

bridge.start();

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
