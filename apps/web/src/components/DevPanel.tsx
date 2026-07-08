import type { HighlightCommand } from '@modelsense/shared';
import type { WebModel } from '../catalog';

interface Props {
  model: WebModel;
  active: HighlightCommand | null;
  onHighlight: (cmd: HighlightCommand) => void;
  onClear: () => void;
}

export function DevPanel({ model, active, onHighlight, onClear }: Props) {
  const sample = model.sampleHighlight;
  return (
    <section className="dev-panel">
      <h2>Dev panel</h2>
      <p className="muted">
        Applies a canned <code>structuredContent</code> highlight, the same command shape the
        agent emits in Phase 2.
      </p>
      <div className="row">
        <button
          type="button"
          disabled={!sample}
          onClick={() =>
            sample &&
            onHighlight({
              type: 'highlight',
              nodeIds: sample.nodeIds,
              color: '#ffcc00',
              exclusive: true,
            })
          }
        >
          {sample ? sample.label : 'No sample highlight for this model'}
        </button>
        <button type="button" className="ghost" disabled={!active} onClick={onClear}>
          Clear
        </button>
      </div>
      {active && <pre className="cmd">{JSON.stringify(active, null, 2)}</pre>}
    </section>
  );
}
