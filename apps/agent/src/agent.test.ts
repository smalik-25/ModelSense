import { describe, it, expect } from 'vitest';
import { decideToolUse, extractScene } from './agent';

const GATED = 'mcp__modelsense__export_report';

describe('decideToolUse (code-enforced tool gating)', () => {
  it('denies any tool that is not the gated one, even with approval available', async () => {
    const approve = async () => true;
    for (const tool of ['Bash', 'mcp__modelsense__load_model', 'WebFetch']) {
      const d = await decideToolUse(tool, {}, 'id-1', approve);
      expect(d.behavior).toBe('deny');
    }
  });

  it('runs the gated tool only after approval, forwarding the input', async () => {
    const d = await decideToolUse(GATED, { format: 'markdown' }, 'id-2', async () => true);
    expect(d).toEqual({ behavior: 'allow', updatedInput: { format: 'markdown' } });
  });

  it('denies the gated tool when approval is refused', async () => {
    const d = await decideToolUse(GATED, { format: 'markdown' }, 'id-3', async () => false);
    expect(d.behavior).toBe('deny');
  });

  it('denies the gated tool when no approval channel exists (never silently allows)', async () => {
    const d = await decideToolUse(GATED, {}, 'id-4', undefined);
    expect(d.behavior).toBe('deny');
  });

  it('passes the tool_use id through to the approval request', async () => {
    let seenId = '';
    await decideToolUse(GATED, {}, 'tool-use-42', async (req) => {
      seenId = req.id;
      return false;
    });
    expect(seenId).toBe('tool-use-42');
  });
});

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
