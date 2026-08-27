import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';

type GroupBadge = { id: string; name: string };
type Person = { id: string; nickname: string; groups: GroupBadge[] };
type OverlayState = { people: Person[]; outgoing: string[]; incoming: string[]; activeGroups: string[] };

export function Overlay() {
  const [state, setState] = useState<OverlayState>({ people: [], outgoing: [], incoming: [], activeGroups: [] });

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
        return (
          <div className={`overlay-person${outgoing ? ' outgoing' : ''}${incoming ? ' incoming' : ''}`} key={person.id}>
            <span className="overlay-row">
              <span className="overlay-name">{person.nickname}</span>
              {person.groups.length > 0 && (
                <span className="overlay-groups">
                {person.groups.map((group) => (
                  <span className={`overlay-group${state.activeGroups.includes(group.id) ? ' active' : ''}`} key={group.id}>{group.name}</span>
                ))}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </main>
  );
}
