import { Suspense, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bounds, Html, Line, OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { CameraFocusCommand, HighlightCommand, MeasurementCommand } from '@modelsense/shared';
import { objectMatchesTargets } from '../lib/highlight';

const originalEmissive = new WeakMap<THREE.MeshStandardMaterial, number>();
const highlightColor = new THREE.Color();

function isStandardMaterial(
  m: THREE.Material | THREE.Material[],
): m is THREE.MeshStandardMaterial {
  return !Array.isArray(m) && 'emissive' in m;
}

/**
 * Apply (or clear) the emissive highlight across the scene. Driven from the
 * render loop rather than a `useEffect([scene, highlight])`: an effect only
 * fires when the Model re-renders with a new command, and under load R3F does
 * not always re-render the Canvas subtree in time, so the swap was silently
 * missed and the mesh stayed un-highlighted (the reported bug). Reading the
 * current command from a ref each frame is immune to that. It only writes when a
 * material's emissive actually differs, so the per-frame traverse stays cheap on
 * these small scenes.
 */
function applyHighlight(scene: THREE.Object3D, highlight: HighlightCommand | null): void {
  const targets = new Set(highlight?.nodeIds ?? []);
  highlightColor.set(highlight?.color ?? '#ffcc00');
  const wantHex = highlightColor.getHex();
  scene.traverse((obj) => {
    // Duck-type on `.isMesh` instead of `instanceof THREE.Mesh` so the match
    // survives a bundler resolving a second copy of three.
    if (!(obj as THREE.Mesh).isMesh) return;
    const mat = (obj as THREE.Mesh).material;
    if (!isStandardMaterial(mat)) return;
    if (!originalEmissive.has(mat)) originalEmissive.set(mat, mat.emissive.getHex());

    if (targets.size > 0 && objectMatchesTargets(obj, targets)) {
      if (mat.emissive.getHex() !== wantHex) {
        mat.emissive.setHex(wantHex);
        mat.emissiveIntensity = 1;
      }
    } else {
      const orig = originalEmissive.get(mat) ?? 0x000000;
      if (mat.emissive.getHex() !== orig) mat.emissive.setHex(orig);
    }
  });
}

function Model({
  url,
  highlightRef,
}: {
  url: string;
  highlightRef: RefObject<HighlightCommand | null>;
}) {
  const { scene } = useGLTF(url);
  useFrame(() => applyHighlight(scene, highlightRef.current));
  return <primitive object={scene} />;
}

interface ControlsLike {
  target?: THREE.Vector3;
  update?: () => void;
}

function CameraRig({ command }: { command: CameraFocusCommand | null }) {
  const { camera, controls } = useThree();
  const goal = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);

  useEffect(() => {
    if (!command?.center) return;
    const center = new THREE.Vector3(command.center[0], command.center[1], command.center[2]);
    const radius = command.radius ?? 1;
    let dir = camera.position.clone().sub(center);
    if (dir.lengthSq() < 1e-6) dir = new THREE.Vector3(1, 1, 1);
    dir.normalize();
    goal.current = {
      pos: center.clone().add(dir.multiplyScalar(Math.max(radius * 3, 0.5))),
      target: center,
    };
  }, [command, camera]);

  useFrame(() => {
    if (!goal.current) return;
    camera.position.lerp(goal.current.pos, 0.12);
    const c = controls as unknown as ControlsLike | null;
    if (c?.target) {
      c.target.lerp(goal.current.target, 0.12);
      c.update?.();
    }
    if (camera.position.distanceTo(goal.current.pos) < 0.02) goal.current = null;
  });

  return null;
}

function LoadingFallback() {
  return (
    <Html center>
      <div className="canvas-loading">Loading model…</div>
    </Html>
  );
}

function MeasurementOverlay({ measurement }: { measurement: MeasurementCommand | null }) {
  if (!measurement || measurement.points.length < 2) return null;
  const pts = measurement.points.map((p) => [p[0], p[1], p[2]] as [number, number, number]);
  const sum = pts.reduce<[number, number, number]>(
    (a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]],
    [0, 0, 0],
  );
  const mid: [number, number, number] = [sum[0] / pts.length, sum[1] / pts.length, sum[2] / pts.length];
  return (
    <group>
      <Line points={pts} color="#4ea1ff" lineWidth={2} />
      <Html position={mid} center distanceFactor={8}>
        <div className="measure-label">{measurement.label}</div>
      </Html>
    </group>
  );
}

export function Viewer({
  url,
  highlight,
  camera,
  measurement,
}: {
  url: string;
  highlight: HighlightCommand | null;
  camera: CameraFocusCommand | null;
  measurement: MeasurementCommand | null;
}) {
  // Feed the highlight into the render loop through a ref. Viewer is a plain DOM
  // component that re-renders whenever the highlight state changes, so this ref
  // is always current, and Model's useFrame reads it even if R3F skips a
  // re-render of the Canvas subtree.
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  return (
    <Canvas
      camera={{ position: [3, 2, 4], fov: 45 }}
      dpr={[1, 2]}
      onCreated={(state) => {
        // Test seam: the highlight-fidelity e2e sets `__MODELSENSE_TEST` before
        // load so it can read emissive state off the live scene. No-op otherwise,
        // so production visitors never get the global.
        const w = window as unknown as {
          __MODELSENSE_TEST?: boolean;
          __modelsenseScene?: THREE.Object3D;
        };
        if (w.__MODELSENSE_TEST) w.__modelsenseScene = state.scene;
      }}
    >
      <color attach="background" args={['#0b0d12']} />
      <hemisphereLight intensity={0.5} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 8, 5]} intensity={1.4} />
      <directionalLight position={[-5, -2, -5]} intensity={0.4} />
      <Suspense fallback={<LoadingFallback />}>
        <Bounds fit clip observe margin={1.2}>
          <Model key={url} url={url} highlightRef={highlightRef} />
        </Bounds>
        <MeasurementOverlay measurement={measurement} />
      </Suspense>
      <CameraRig command={camera} />
      <OrbitControls makeDefault />
    </Canvas>
  );
}
