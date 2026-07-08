import { describe, it, expect } from 'vitest';
import { extractScene } from './agent';

// Offline: verify we recover SceneCommands from tool_result content (no live API).
describe('extractScene', () => {
  it('parses a highlight command from tool_result text blocks', () => {
    const content = [
      {
        type: 'text',
        text: JSON.stringify({
          type: 'highlight',
          nodeIds: ['Wheels', 'Wheels.001'],
          color: '#ffcc00',
          exclusive: true,
        }),
      },
    ];
    expect(extractScene(content)?.type).toBe('highlight');
  });

  it('parses a camera_focus command from a raw string', () => {
    const scene = extractScene(
      JSON.stringify({ type: 'camera_focus', nodeId: 'x', center: [0, 0, 0], radius: 1 }),
    );
    expect(scene?.type).toBe('camera_focus');
  });

  it('returns null for non-scene tool output (e.g. stats)', () => {
    expect(extractScene(JSON.stringify({ totals: { triangles: 5 } }))).toBeNull();
  });

  it('returns null for plain text', () => {
    expect(extractScene([{ type: 'text', text: 'Loaded the model.' }])).toBeNull();
  });
});
