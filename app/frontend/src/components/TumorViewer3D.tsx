import React, { useEffect, useState, useRef } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { extend } from '@react-three/fiber';

extend({
  Mesh: THREE.Mesh,
  BufferGeometry: THREE.BufferGeometry,
  MeshStandardMaterial: THREE.MeshStandardMaterial,
  SphereGeometry: THREE.SphereGeometry,
});

// ─── Tumor mesh (solo se muestra si hay geometría) ───────────────────────────────
function TumorMesh({ stlUrl, visible }: { stlUrl: string | null; visible: boolean }) {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [error, setError] = useState(false);
  
  useEffect(() => {
    if (!stlUrl || !visible) return;
    setError(false);
    const loader = new STLLoader();
    loader.load(stlUrl, 
      (geo) => {
        geo.computeBoundingBox();
        const center = new THREE.Vector3();
        geo.boundingBox!.getCenter(center);
        geo.translate(-center.x, -center.y, -center.z);
        geo.computeVertexNormals();
        setGeometry(geo);
      },
      undefined,
      () => setError(true)
    );
  }, [stlUrl, visible]);
  
  if (!visible || error) return null;
  if (!geometry) {
    return (
      <mesh>
        <sphereGeometry args={[1.2, 16, 16]} />
        <meshStandardMaterial color="#1e3a5f" wireframe opacity={0.3} transparent />
      </mesh>
    );
  }
  
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#ffcf26" roughness={0.4} metalness={0.1} side={THREE.DoubleSide} />
    </mesh>
  );
}

// ─── Gizmo: sincroniza cuaternión de cámara ───────────────────────────────────
function GizmoSync({ onRotation }: { onRotation: (q: THREE.Quaternion) => void }) {
  const { camera } = useThree();
  useFrame(() => onRotation(camera.quaternion.clone()));
  return null;
}

// ─── Gizmo SVG overlay ────────────────────────────────────────────────────────
const GIZMO_AXES = [
  { dir: new THREE.Vector3( 0,  0,  1), label: 'S', color: '#55aaff' },
  { dir: new THREE.Vector3( 0,  0, -1), label: 'I', color: '#3366cc' },
  { dir: new THREE.Vector3( 0,  1,  0), label: 'A', color: '#44dd44' },
  { dir: new THREE.Vector3( 0, -1,  0), label: 'P', color: '#228822' },
  { dir: new THREE.Vector3(-1,  0,  0), label: 'L', color: '#ff5555' },
  { dir: new THREE.Vector3( 1,  0,  0), label: 'R', color: '#aa2222' },
];

function GizmoOverlay({ q }: { q: THREE.Quaternion }) {
  const SZ  = 84;
  const CX  = SZ / 2;
  const CY  = SZ / 2;
  const RAD = 30;

  const pts = GIZMO_AXES.map(ax => {
    const v = ax.dir.clone().applyQuaternion(q);
    return { label: ax.label, color: ax.color, x: CX + v.x * RAD, y: CY - v.y * RAD, z: v.z };
  }).sort((a, b) => a.z - b.z);

  return (
    <div style={{
      position: 'absolute', bottom: 6, left: 6,
      width: SZ, height: SZ, pointerEvents: 'none',
    }}>
      <svg width={SZ} height={SZ}>
        {pts.map(p => (
          <line key={`l${p.label}`}
            x1={CX} y1={CY} x2={p.x} y2={p.y}
            stroke={p.color}
            strokeWidth={p.z > 0 ? 1.6 : 0.8}
            strokeOpacity={p.z > 0 ? 0.9 : 0.35}
          />
        ))}
        {pts.map(p => {
          const front = p.z > 0;
          const r     = front ? 10 : 6.5;
          const op    = front ? 1.0 : 0.4;
          const fs    = front ? 8.5 : 6.5;
          return (
            <g key={`g${p.label}`}>
              <circle cx={p.x} cy={p.y} r={r}
                fill={p.color} fillOpacity={op * 0.82}
                stroke={p.color} strokeWidth={0.8} strokeOpacity={op} />
              <text x={p.x} y={p.y + fs * 0.38}
                textAnchor="middle" fontSize={fs}
                fontFamily="monospace" fontWeight="bold"
                fill="white" fillOpacity={op}>
                {p.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Escena Three.js (siempre visible) ──────────────────────────────────────────
// CORRECCIÓN: onRotation ya no es () => {} — se conecta correctamente al estado
// del componente padre para que el gizmo se sincronice con la cámara.
function Scene({
  stlUrl,
  showModel,
  onRotation,
}: {
  stlUrl: string | null;
  showModel: boolean;
  onRotation: (q: THREE.Quaternion) => void;
}) {
  return (
    <>
      <ambientLight intensity={1.4} />
      <directionalLight position={[60, 60, 60]}   intensity={1.8} />
      <directionalLight position={[-40, -30, -40]} intensity={0.5} />
      
      {/* Modelo 3D del tumor (solo si showModel es true y hay stlUrl) */}
      <TumorMesh stlUrl={stlUrl} visible={showModel} />
      
      {/* Siempre mostrar controles de órbita */}
      <OrbitControls enableZoom enablePan autoRotate={false} minDistance={5} maxDistance={500} />
      <GizmoSync onRotation={onRotation} />
    </>
  );
}

// ─── Componente público ───────────────────────────────────────────────────────
interface TumorViewer3DProps {
  sessionId?:     string;
  refreshKey?:    number;
  showEmptyState?: boolean;
}

export function TumorViewer3D({ sessionId, refreshKey = 0, showEmptyState = false }: TumorViewer3DProps) {
  const [stlUrl, setStlUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'empty' | 'error'>('idle');
  const [camQ,   setCamQ]   = useState(() => new THREE.Quaternion());

  // CORRECCIÓN: ref para el timeout de reintento automático
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sessionId || showEmptyState) {
      setStatus('idle');
      setStlUrl(null);
      return;
    }

    let cancelled = false;

    const load = () => {
      setStatus('loading');
      // CORRECCIÓN: se quita ?t=Date.now() para que el navegador y el backend
      // puedan cachear la respuesta. El backend ya cachea la malla en memory_cache.
      const url = `http://localhost:8000/api/get-3d-model/${sessionId}?k=${refreshKey}`;
      fetch(url)
        .then(async res => {
          if (cancelled) return;
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          if (blob.size < 200) {
            setStatus('empty');
            setStlUrl(null);
          } else {
            setStlUrl(url);
            setStatus('ok');
          }
        })
        .catch(() => {
          if (cancelled) return;
          setStlUrl(null);
          setStatus('error');
          // CORRECCIÓN: reintento automático tras 3 s si el servidor estaba
          // ocupado generando la malla (marching cubes puede tardar en M1).
          retryRef.current = setTimeout(load, 3000);
        });
    };

    load();

    return () => {
      cancelled = true;
      if (retryRef.current) {
        clearTimeout(retryRef.current);
        retryRef.current = null;
      }
    };
  }, [sessionId, refreshKey, showEmptyState]);

  // Determinar si mostrar el modelo (solo si no estamos en empty state y tenemos URL)
  const showModel = !showEmptyState && status === 'ok' && stlUrl !== null;

  return (
    <div className="h-full flex flex-col bg-[#b3caec] overflow-hidden">
      <div className="bg-[#b3caec] px-3 py-1 border-b border-gray-800 flex-shrink-0 flex items-center justify-between">
        <span className="text-[#ffcf26] text-[10px] font-bold uppercase tracking-widest">MODELO 3D</span>
        {status === 'loading' && !showEmptyState && (
          <span className="text-gray-500 text-[9px] font-mono animate-pulse">generando...</span>
        )}
      </div>

      <div className="flex-1 relative overflow-hidden bg-[#b3caec]">
        <Canvas
          shadows={false}
          camera={{ position: [0, 0, 150], fov: 45 }}
          style={{ background: '#b3caec' }}
        >
          {/* CORRECCIÓN: se pasa setCamQ como onRotation para que el gizmo funcione */}
          <Scene stlUrl={stlUrl} showModel={showModel} onRotation={setCamQ} />
        </Canvas>

        {/* Siempre mostrar el gizmo y la leyenda, independientemente del estado */}
        <GizmoOverlay q={camQ} />

        {/* Mensaje sutil cuando no hay modelo */}
        {showEmptyState && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-black/40 backdrop-blur-sm rounded-lg px-4 py-2">
              <p className="text-white/80 text-xs font-mono">
                Aplica segmentación automática para ver el modelo 3D
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
