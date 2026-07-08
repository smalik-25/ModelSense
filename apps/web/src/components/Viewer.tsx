import { Suspense, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { Bounds, OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { HighlightCommand } from '@modelsense/shared';

// Remember each material's original emissive so we can restore it when a
// highlight is cleared or moved. Keyed by material instance.
const originalEmissive = new WeakMap<THREE.MeshStandardMaterial, number>();

function isStandardMaterial(
  m: THREE.Material | THREE.Material[],
): m is THREE.MeshStandardMaterial {
  return !Array.isArray(m) && 'emissive' in m;
}

function Model({ url, highlight }: { url: string; highlight: HighlightCommand | null }) {
  const { scene } = useGLTF(url);

  useEffect(() => {
    const targets = new Set(highlight?.nodeIds ?? []);
    const color = new THREE.Color(highlight?.color ?? '#ffcc00');
    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material;
      if (!isStandardMaterial(mat)) return;
      if (!originalEmissive.has(mat)) originalEmissive.set(mat, mat.emissive.getHex());

      // A mesh is targeted if it or any ancestor is named in nodeIds.
      let node: THREE.Object3D | null = obj;
      let targeted = false;
      while (node) {
        if (targets.has(node.name)) {
          targeted = true;
          break;
        }
        node = node.parent;
      }

      if (targeted) {
        mat.emissive.copy(color);
        mat.emissiveIntensity = 1;
      } else {
        mat.emissive.setHex(originalEmissive.get(mat) ?? 0x000000);
      }
    });
  }, [scene, highlight]);

  return <primitive object={scene} />;
}

export function Viewer({ url, highlight }: { url: string; highlight: HighlightCommand | null }) {
  return (
    <Canvas camera={{ position: [3, 2, 4], fov: 45 }} dpr={[1, 2]}>
      <color attach="background" args={['#0b0d12']} />
      <hemisphereLight intensity={0.5} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 8, 5]} intensity={1.4} />
      <directionalLight position={[-5, -2, -5]} intensity={0.4} />
      <Suspense fallback={null}>
        <Bounds fit clip observe margin={1.2}>
          {/* key forces a clean remount (and camera refit) on model switch */}
          <Model key={url} url={url} highlight={highlight} />
        </Bounds>
      </Suspense>
      <OrbitControls makeDefault />
    </Canvas>
  );
}
