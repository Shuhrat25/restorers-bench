import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useThree } from '@react-three/fiber'
import { AdaptiveDpr, Grid, OrbitControls } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import { Artifact, type Progress } from './Artifact'
import { Workshop, type BenchState } from './Workshop'
import { ARTIFACTS, crateSize, crateSpot, pedestalRadius, type Phase, type Settings } from '../artifact'

type Props = {
  settings: Settings
  hintLevel: number
  selectedId: number | null
  onSelect: (id: number | null) => void
  onProgress: (p: Progress) => void
  onWrong: () => void
  revealAll: number
  phase: Phase
  onPhase: (p: Phase) => void
  onStability: (v: number) => void
  onImpact: () => void
  onBackside: (hidden: boolean) => void
}

/** Ставит камеру по габаритам экспоната и вписывает его в узкую сторону кадра. */
function CameraRig({ height, radius, artifactId }: { height: number; radius: number; artifactId: string }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3; update: () => void } | null

  useEffect(() => {
    const persp = camera as THREE.PerspectiveCamera
    // берём радиус разлёта черепков, а не самого экспоната
    const span = Math.max(radius * 4.7, height * 1.05)
    const vFov = THREE.MathUtils.degToRad(persp.fov)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * persp.aspect)
    const dist = span / Math.sin(Math.min(vFov, hFov) / 2)
    camera.position.set(dist * 0.42, height * 1.05, dist * 0.78)
    camera.lookAt(0, height * 0.42, 0)
    if (controls) {
      controls.target.set(0, height * 0.42, 0)
      controls.update()
    }
  }, [height, radius, artifactId, camera, controls])

  return null
}

export function Scene({
  settings,
  hintLevel,
  selectedId,
  onSelect,
  onProgress,
  onWrong,
  revealAll,
  phase,
  onPhase,
  onStability,
  onImpact,
  onBackside,
}: Props) {
  const [size, setSize] = useState({ height: 6, radius: 3 })
  const onSize = useCallback((height: number, radius: number) => setSize({ height, radius }), [])
  const dragging = useRef(false)
  // «находка над подставкой» меняется каждый кадр — держим вне состояния React
  const bench = useRef<BenchState>({ over: false }).current

  const def = useMemo(
    () => ARTIFACTS.find((a) => a.id === settings.artifactId) ?? ARTIFACTS[0],
    [settings.artifactId],
  )

  return (
    <Canvas
      shadows={{ type: THREE.PCFShadowMap }}
      dpr={[1, 1.5]}
      performance={{ min: 0.85 }}
      gl={{ antialias: false, powerPreference: 'high-performance', toneMapping: THREE.NeutralToneMapping }}
      camera={{ position: [8, 5, 11], fov: 42, near: 0.1, far: 300 }}
      onCreated={(state) => {
        if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__three = state
      }}
    >
      <color attach="background" args={['#0a0c10']} />
      <fog attach="fog" args={['#0a0c10', 26, 80]} />

      {/* свет реставрационной мастерской: мягкий верхний плюс подсветка сбоку */}
      <hemisphereLight color="#e8f0ff" groundColor="#2a2520" intensity={0.9} />
      <directionalLight
        position={[7, 12, 6]}
        intensity={2.4}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      >
        <orthographicCamera attach="shadow-camera" args={[-14, 14, 14, -14, 1, 40]} />
      </directionalLight>
      <directionalLight position={[-8, 5, -7]} intensity={0.7} color="#9fc4ff" />

      {/* стол реставратора */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow raycast={() => null}>
        <circleGeometry args={[Math.max(size.radius * 4, 9), 64]} />
        <meshStandardMaterial color="#15181d" roughness={0.9} metalness={0} />
      </mesh>
      <Grid
        raycast={() => null}
        position={[0, 0, 0]}
        args={[40, 40]}
        cellSize={0.5}
        cellThickness={0.5}
        cellColor="#1d2733"
        sectionSize={2.5}
        sectionThickness={1}
        sectionColor="#2b4257"
        fadeDistance={38}
        fadeStrength={1.3}
        infiniteGrid
      />

      <Workshop
        crate={crateSpot(size.radius)}
        crateSize={crateSize(size.radius, size.height)}
        pedestal={pedestalRadius(size.radius)}
        bench={bench}
        armed={phase === 'carry'}
      />

      <Suspense fallback={null}>
        <Artifact
          key={def.id}
          def={def}
          settings={settings}
          hintLevel={hintLevel}
          selectedId={selectedId}
          onSelect={onSelect}
          onProgress={onProgress}
          onWrong={onWrong}
          onSize={onSize}
          revealAll={revealAll}
          phase={phase}
          onPhase={onPhase}
          onStability={onStability}
          onImpact={onImpact}
          onBackside={onBackside}
          bench={bench}
        />
      </Suspense>

      <CameraRig height={size.height} radius={size.radius} artifactId={def.id} />

      <OrbitControls
        makeDefault
        enableDamping={false}
        autoRotate={settings.autoRotate}
        autoRotateSpeed={0.4}
        minDistance={3}
        maxDistance={60}
        minPolarAngle={0.001}
        maxPolarAngle={Math.PI / 2.02}
        onStart={() => (dragging.current = true)}
        onEnd={() => (dragging.current = false)}
      />

      <AdaptiveDpr />
      <EffectComposer multisampling={2}>
        <Bloom intensity={0.75} luminanceThreshold={0.5} luminanceSmoothing={0.3} mipmapBlur />
        <Vignette eskil={false} offset={0.28} darkness={0.8} />
      </EffectComposer>
    </Canvas>
  )
}
