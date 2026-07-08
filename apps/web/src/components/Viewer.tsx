import { Suspense, useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bounds, Html, Line, OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { CameraFocusCommand, HighlightCommand, MeasurementCommand } from '@modelsense/shared';

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
  return (
    <Canvas camera={{ position: [3, 2, 4], fov: 45 }} dpr={[1, 2]}>
      <color attach="background" args={['#0b0d12']} />
      <hemisphereLight intensity={0.5} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 8, 5]} intensity={1.4} />
      <directionalLight position={[-5, -2, -5]} intensity={0.4} />
      <Suspense fallback={null}>
        <Bounds fit clip observe margin={1.2}>
          <Model key={url} url={url} highlight={highlight} />
        </Bounds>
        <MeasurementOverlay measurement={measurement} />
      </Suspense>
      <CameraRig command={camera} />
      <OrbitControls makeDefault />
    </Canvas>
  );
}
