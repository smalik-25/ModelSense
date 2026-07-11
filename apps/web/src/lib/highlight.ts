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
 * GLTFLoader preserves the untouched glTF name on `object.userData.name`, so we
 * match against both: the sanitized `.name` and the original `userData.name`.
 * We walk up the parents because a multi-primitive glTF node becomes a Group
 * whose child meshes carry generated names (Cesium_Milk_Truck_1, ...) while the
 * matching name lives on the parent.
 */
export function objectMatchesTargets(obj: Object3D, targets: ReadonlySet<string>): boolean {
  let node: Object3D | null = obj;
  while (node) {
    if (targets.has(node.name)) return true;
    const original = node.userData?.name;
    if (typeof original === 'string' && targets.has(original)) return true;
    node = node.parent;
  }
  return false;
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
