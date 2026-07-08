import { z } from 'zod';

/**
 * Scene commands are the `structuredContent` a tool returns for the viewer to
 * apply to the three.js scene. The agent forwards them verbatim to the web app.
 * This union is the contract between the server (producer) and the web viewer
 * (consumer); both import it from here.
 */

/** A six-digit hex color, e.g. `#ffcc00`. */
export const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'expected a hex color like #ffcc00');
export type HexColor = z.infer<typeof HexColor>;

/** A point in glTF scene units (right-handed, Y up). */
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

export const HighlightCommand = z.object({
  type: z.literal('highlight'),
  nodeIds: z.array(z.string()).min(1),
  color: HexColor.default('#ffcc00'),
  /** When true, clear any existing highlights before applying this one. */
  exclusive: z.boolean().default(false),
});
export type HighlightCommand = z.infer<typeof HighlightCommand>;

export const CameraFocusCommand = z.object({
  type: z.literal('camera_focus'),
  /** Focus on a named node, or on an explicit bounding sphere, or both. */
  nodeId: z.string().optional(),
  center: Vec3.optional(),
  radius: z.number().positive().optional(),
});
export type CameraFocusCommand = z.infer<typeof CameraFocusCommand>;

export const MeasurementCommand = z.object({
  type: z.literal('measurement'),
  label: z.string(),
  /** One point for a bbox label anchor, two for a distance line. */
  points: z.array(Vec3).min(1),
  value: z.number(),
  /** glTF has no real-world unit; measurements are always in scene units. */
  unit: z.literal('scene-units'),
});
export type MeasurementCommand = z.infer<typeof MeasurementCommand>;

export const SceneCommand = z.discriminatedUnion('type', [
  HighlightCommand,
  CameraFocusCommand,
  MeasurementCommand,
]);
export type SceneCommand = z.infer<typeof SceneCommand>;
