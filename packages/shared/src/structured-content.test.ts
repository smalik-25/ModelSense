import { describe, it, expect } from 'vitest';
import { SceneCommand, HighlightCommand } from './index';

describe('SceneCommand', () => {
  it('parses a highlight command and applies defaults', () => {
    const cmd = SceneCommand.parse({ type: 'highlight', nodeIds: ['node-3'] });
    expect(cmd.type).toBe('highlight');
    if (cmd.type === 'highlight') {
      expect(cmd.color).toBe('#ffcc00');
      expect(cmd.exclusive).toBe(false);
    }
  });

  it('parses a camera_focus command with an explicit bounding sphere', () => {
    const cmd = SceneCommand.parse({
      type: 'camera_focus',
      center: [1, 2, 3],
      radius: 4,
    });
    expect(cmd.type).toBe('camera_focus');
  });

  it('rejects an unknown command type', () => {
    expect(() => SceneCommand.parse({ type: 'nope' })).toThrow();
  });

  it('rejects a highlight with no node ids', () => {
    expect(() => HighlightCommand.parse({ type: 'highlight', nodeIds: [] })).toThrow();
  });

  it('rejects a malformed color', () => {
    expect(() =>
      HighlightCommand.parse({ type: 'highlight', nodeIds: ['n1'], color: 'red' }),
    ).toThrow();
  });
});
