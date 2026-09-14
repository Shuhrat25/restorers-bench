import { useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'

/** Общая на сцену ссылка: находка над подставкой. Меняется каждый кадр, без ререндеров. */
export type BenchState = { over: boolean }

const WOOD = new THREE.MeshStandardMaterial({ color: '#4b3a27', roughness: 0.92 })
const WOOD_DARK = new THREE.MeshStandardMaterial({ color: '#2e2317', roughness: 0.95 })
const STONE = new THREE.MeshStandardMaterial({ color: '#232830', roughness: 0.75, metalness: 0.05 })
const STONE_TOP = new THREE.MeshStandardMaterial({ color: '#2d333d', roughness: 0.6, metalness: 0.05 })

type Props = {
  /** Где стоит ящик с раскопа. */
  crate: [number, number, number]
  crateSize: { w: number; d: number; h: number }
  pedestal: number
  bench: BenchState
  /** Подставка ждёт находку — только во время переноса. */
  armed: boolean
}

/**
 * Обстановка мастерской: ящик, из которого достают находку, и подставка,
 * на которую её надо донести. Ничего из этого не должно ловить клики —
 * иначе стенка ящика перехватит нажатие на саму находку.
 */
export function Workshop({ crate, crateSize, pedestal, bench, armed }: Props) {
  const ring = useRef<THREE.MeshBasicMaterial>(null)
  const { w, d, h } = crateSize
  const t = Math.max(w * 0.035, 0.07)

  useFrame((_, delta) => {
    if (!ring.current) return
    const want = !armed ? 0 : bench.over ? 0.8 : 0.16
    ring.current.opacity = THREE.MathUtils.damp(ring.current.opacity, want, 9, Math.min(delta, 0.05))
  })

  return (
    <group raycast={() => null}>
      {/* подставка */}
      <mesh position={[0, 0.03, 0]} material={STONE} receiveShadow raycast={() => null}>
        <cylinderGeometry args={[pedestal, pedestal * 1.06, 0.06, 56]} />
      </mesh>
      <mesh position={[0, 0.065, 0]} material={STONE_TOP} receiveShadow raycast={() => null}>
        <cylinderGeometry args={[pedestal * 0.93, pedestal * 0.93, 0.02, 56]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.08, 0]} raycast={() => null}>
        <ringGeometry args={[pedestal * 0.9, pedestal * 1.02, 64]} />
        <meshBasicMaterial ref={ring} color="#1ec8ff" transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* ящик с раскопа: дно и четыре стенки */}
      <group position={crate}>
        <mesh position={[0, t / 2, 0]} material={WOOD_DARK} receiveShadow raycast={() => null}>
          <boxGeometry args={[w, t, d]} />
        </mesh>
        {([
          [0, h / 2, -d / 2 + t / 2, w, h, t],
          [0, h / 2, d / 2 - t / 2, w, h, t],
          [-w / 2 + t / 2, h / 2, 0, t, h, d],
          [w / 2 - t / 2, h / 2, 0, t, h, d],
        ] as const).map(([x, y, z, sx, sy, sz], i) => (
          <mesh key={i} position={[x, y, z]} material={WOOD} castShadow receiveShadow raycast={() => null}>
            <boxGeometry args={[sx, sy, sz]} />
          </mesh>
        ))}
        {/* обвязка по переднему и заднему краю — чтобы ящик читался ящиком */}
        {[-1, 1].map((side) => (
          <mesh
            key={side}
            position={[0, h, side * (d / 2 - t / 2)]}
            material={WOOD_DARK}
            castShadow
            raycast={() => null}
          >
            <boxGeometry args={[w + t * 1.6, t * 1.3, t * 1.6]} />
          </mesh>
        ))}
      </group>
    </group>
  )
}
