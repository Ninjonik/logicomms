import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';

type Person = { id: string; nickname: string };
type Group = { id: string; name: string; key: string; people: Person[] };
type OverlayState = { groups: Group[]; outgoing: string[]; incoming: string[] };

const shorten = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit)}…` : value;

export function Overlay() {
  const [state, setState] = useState<OverlayState>({ groups: [], outgoing: [], incoming: [] });

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
      {state.groups.map((group) => (
        <section className="overlay-group-card" key={group.id}>
          <header className="overlay-group-heading">
            <span title={group.name}>{shorten(group.name, 20)}</span>
            {group.key && <kbd>{shorten(group.key.replace(/^Key/i, '').replace(/^Digit/i, ''), 8)}</kbd>}
          </header>
          {group.people.map((person) => {
            const outgoing = state.outgoing.includes(person.id);
            const incoming = state.incoming.includes(person.id);
            return (
              <div className={`overlay-person${outgoing ? ' outgoing' : ''}${incoming ? ' incoming' : ''}`} key={person.id}>
                <span className="overlay-name" title={person.nickname}>{shorten(person.nickname, 20)}</span>
              </div>
            );
          })}
        </section>
      ))}
    </main>
  );
}
