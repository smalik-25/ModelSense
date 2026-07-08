import { useState } from 'react';
import type { HighlightCommand } from '@modelsense/shared';
import { Viewer } from './components/Viewer';
import { DevPanel } from './components/DevPanel';
import { WEB_CATALOG } from './catalog';

const DEFAULT_MODEL = WEB_CATALOG[0]!;

export function App() {
  const [modelId, setModelId] = useState(DEFAULT_MODEL.id);
  const [highlight, setHighlight] = useState<HighlightCommand | null>(null);
  const model = WEB_CATALOG.find((m) => m.id === modelId) ?? DEFAULT_MODEL;

  return (
    <div className="app">
      <div className="canvas-pane">
        <Viewer url={model.url} highlight={highlight} />
        <div className="badge">ModelSense</div>
      </div>
      <aside className="side-pane">
        <header>
          <h1>ModelSense</h1>
          <p className="muted">Phase 1 viewer. Agent chat lands in Phase 2.</p>
        </header>

        <label className="field">
          <span>Model</span>
          <select
            value={modelId}
            onChange={(e) => {
              setModelId(e.target.value);
              setHighlight(null);
            }}
          >
            {WEB_CATALOG.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>

        <DevPanel
          model={model}
          active={highlight}
          onHighlight={setHighlight}
          onClear={() => setHighlight(null)}
        />
      </aside>
    </div>
  );
}
