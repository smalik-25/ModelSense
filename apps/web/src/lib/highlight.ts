import type { Mesh, Object3D } from 'three';

/**
 * Match rule for the viewer's emissive highlight.
 *
 * The MCP server highlights by the ORIGINAL glTF node id (e.g. "Wheels.001").
 * three.js `GLTFLoader` runs every node name through `sanitizeNodeName`, which
 * strips `[ ] . : /` and turns whitespace into `_`, so that glTF node becomes a
 * three.js object named "Wheels001". Matching only on `object.name` therefore
 * silently misses every dotted id (Wheels.001, Node.001, ...).
 *
 * We match against three id sources, walking up the parents (a multi-primitive
 * glTF node becomes a Group whose child meshes carry generated names while the
 * matching name lives on the parent):
 *  - the sanitized `.name`,
 *  - the original glTF name GLTFLoader preserves on `userData.name`,
 *  - `userData.modelsenseId`, which `stampModelIds` sets from the glTF node index.
 * The last one is what resolves the server's positional `node-<index>` ids: an
 * unnamed node (Box.glb's mesh) has no usable name on either side, so without it
 * the highlight silently no-ops.
 */
export function objectMatchesTargets(obj: Object3D, targets: ReadonlySet<string>): boolean {
  let node: Object3D | null = obj;
  while (node) {
    if (targets.has(node.name)) return true;
    const original = node.userData?.name;
    if (typeof original === 'string' && targets.has(original)) return true;
    const stamped = node.userData?.modelsenseId;
    if (typeof stamped === 'string' && targets.has(stamped)) return true;
    node = node.parent;
  }
  return false;
}

/**
 * Stamp every object that maps to a glTF node with `userData.modelsenseId =
 * "node-<index>"`, so the viewer can resolve the server's positional ids.
 *
 * The server addresses an unnamed (or duplicately named) node by its position in
 * the glTF `nodes` array. GLTFLoader records that same index on
 * `parser.associations` (an object -> `{ nodes: index, ... }` map), so mirroring it
 * onto `userData` gives every node a handle the matcher can find, named or not.
 * Idempotent: safe to call again after a model swap.
 *
 * The parameter is read through a narrow cast rather than a typed shape: three
 * types `associations` with concrete key/value types that do not structurally
 * match a loose Map (Map keys are contravariant), so a typed parameter would
 * reject the real GLTFLoader result.
 */
export function stampModelIds(gltf: { parser?: unknown }): void {
  const parser = gltf.parser as
    | { associations?: Map<object, { nodes?: number } | undefined> }
    | undefined;
  const associations = parser?.associations;
  if (!associations) return;
  for (const [obj, ref] of associations) {
    const idx = ref?.nodes;
    if (typeof idx !== 'number') continue;
    const target = obj as Object3D;
    if (target && typeof target.userData === 'object') {
      target.userData.modelsenseId = `node-${idx}`;
    }
  }
}

/** Every mesh in `scene` that a highlight for `nodeIds` should light up. */
export function collectHighlightedMeshes(scene: Object3D, nodeIds: readonly string[]): Mesh[] {
  const targets = new Set(nodeIds);
  const hits: Mesh[] = [];
  scene.traverse((obj) => {
    // Duck-type on `.isMesh` rather than `instanceof THREE.Mesh`: the loaded
    // scene comes from drei's GLTFLoader, and an `instanceof` check is brittle
    // if a bundler ever resolves a second copy of three.
    if ((obj as Mesh).isMesh && objectMatchesTargets(obj, targets)) hits.push(obj as Mesh);
  });
  return hits;
}
