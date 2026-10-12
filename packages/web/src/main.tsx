import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type AppStart } from './App';
import { loadHost, saveHost } from './hosts';
import './styles.css';

/** Which machine the page shows. Each machine is a hub of its own, so switching starts the app over on it. */
function Root() {
  const [at, setAt] = useState<{ hostId: string | null; start?: AppStart }>(() => ({ hostId: loadHost() }));
  return (
    <App
      key={at.hostId ?? ''}
      hostId={at.hostId}
      start={at.start}
      onHost={(hostId, start) => {
        saveHost(hostId);
        setAt({ hostId, start });
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
