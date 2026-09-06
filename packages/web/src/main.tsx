import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { SessionProvider } from './auth/SessionProvider';
import './index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    {/*
      Inside the router, because the login form it can put in front of the application still
      leaves the address bar on the page the operator was heading for — and the header's account
      links are ordinary navigation.
    */}
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
