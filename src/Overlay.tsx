import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';

type Person = { id: string; nickname: string };
type OverlayState = { people: Person[]; outgoing: string[]; incoming: string[] };

export function Overlay() {
  const [state, setState] = useState<OverlayState>({ people: [], outgoing: [], incoming: [] });

  useEffect(() => {
    document.body.classList.add('overlay-window');
    document.documentElement.classList.add('overlay-document');
    let unlisten: (() => void) | undefined;
    void listen<OverlayState>('overlay-state', (event) => setState(event.payload)).then((fn) => (unlisten = fn));
    return () => {
      document.body.classList.remove('overlay-window');
      document.documentElement.classList.remove('overlay-document');
      unlisten?.();
    };
  }, []);

  return (
    <main className="voice-overlay">
      {state.people.map((person) => {
        const outgoing = state.outgoing.includes(person.id);
        const incoming = state.incoming.includes(person.id);
        return <div className={`overlay-person${outgoing ? ' outgoing' : ''}${incoming ? ' incoming' : ''}`} key={person.id}>{person.nickname}</div>;
      })}
    </main>
  );
}
