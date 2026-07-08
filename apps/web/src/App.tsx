import { useEffect, useState } from 'react';
import type {
  CameraFocusCommand,
  HighlightCommand,
  MeasurementCommand,
  SceneCommand,
} from '@modelsense/shared';
import { Viewer } from './components/Viewer';
import { Chat } from './components/Chat';
import { wakeAgent } from './lib/agentClient';
import { WEB_CATALOG } from './catalog';

const DEFAULT_MODEL = WEB_CATALOG[0]!;

export function App() {
  // Wake the Render free-tier service on load so the first chat is not a cold start.
  useEffect(() => {
    wakeAgent();
  }, []);

  const [modelId, setModelId] = useState(DEFAULT_MODEL.id);
  const [highlight, setHighlight] = useState<HighlightCommand | null>(null);
  const [camera, setCamera] = useState<CameraFocusCommand | null>(null);
  const [measurement, setMeasurement] = useState<MeasurementCommand | null>(null);
  const model = WEB_CATALOG.find((m) => m.id === modelId) ?? DEFAULT_MODEL;

  const onScene = (cmd: SceneCommand) => {
    if (cmd.type === 'highlight') setHighlight(cmd);
    else if (cmd.type === 'camera_focus') setCamera(cmd);
    else if (cmd.type === 'measurement') setMeasurement(cmd);
  };

  const resetScene = () => {
    setHighlight(null);
    setCamera(null);
    setMeasurement(null);
  };

  return (
    <div className="app">
      <div className="canvas-pane">
        <Viewer url={model.url} highlight={highlight} camera={camera} measurement={measurement} />
        <div className="badge">ModelSense</div>
      </div>
      <aside className="side-pane">
        <header>
          <h1>ModelSense</h1>
          <label className="field inline">
            <span>Model</span>
            <select
              value={modelId}
              onChange={(e) => {
                setModelId(e.target.value);
                resetScene();
              }}
            >
              {WEB_CATALOG.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </header>
        <Chat modelId={modelId} onScene={onScene} />
      </aside>
    </div>
  );
}
