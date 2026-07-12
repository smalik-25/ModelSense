import { useEffect, useState } from 'react';
import type {
  CameraFocusCommand,
  HighlightCommand,
  MeasurementCommand,
  SceneCommand,
} from '@modelsense/shared';
import { Viewer } from './components/Viewer';
import { Chat } from './components/Chat';
import { ErrorBoundary } from './components/ErrorBoundary';
import { wakeAgent } from './lib/agentClient';
import { WEB_CATALOG } from './catalog';

const DEFAULT_MODEL = WEB_CATALOG[0]!;

export function App() {
  // Wake the Render free-tier service on load, and again when the tab regains
  // focus, so a chat after the 15-min idle spin-down is not a cold start.
  useEffect(() => {
    wakeAgent();
    const onVisible = () => {
      if (document.visibilityState === 'visible') wakeAgent();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const [modelId, setModelId] = useState(DEFAULT_MODEL.id);
  // A turn is in flight. Switching models mid-turn would apply the running turn's
  // highlight/camera commands to the newly loaded model, so the picker is locked
  // while busy.
  const [chatBusy, setChatBusy] = useState(false);
  const [highlight, setHighlight] = useState<HighlightCommand | null>(null);
  const [camera, setCamera] = useState<CameraFocusCommand | null>(null);
  const [measurement, setMeasurement] = useState<MeasurementCommand | null>(null);
  const model = WEB_CATALOG.find((m) => m.id === modelId) ?? DEFAULT_MODEL;

  const onScene = (cmd: SceneCommand) => {
    if (cmd.type === 'highlight')
      // exclusive replaces; otherwise add to the currently highlighted set (honors
      // the schema's exclusive flag instead of always replacing).
      setHighlight((prev) =>
        cmd.exclusive || !prev
          ? cmd
          : { ...cmd, nodeIds: Array.from(new Set([...prev.nodeIds, ...cmd.nodeIds])) },
      );
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
        <ErrorBoundary
          resetKeys={[modelId]}
          fallback={<div className="viewer-fallback">Could not load the 3D view in this browser.</div>}
        >
          <Viewer url={model.url} highlight={highlight} camera={camera} measurement={measurement} />
        </ErrorBoundary>
        <div className="badge">ModelSense</div>
      </div>
      <aside className="side-pane">
        <header>
          <h1>ModelSense</h1>
          <label className="field inline">
            <span>Model</span>
            <select
              value={modelId}
              disabled={chatBusy}
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
        <Chat modelId={modelId} onScene={onScene} onBusyChange={setChatBusy} />
      </aside>
    </div>
  );
}
