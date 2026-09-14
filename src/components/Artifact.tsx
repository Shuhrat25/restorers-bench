import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { KTX2Loader } from 'three-stdlib'
import { mergeSceneGeometry } from '../three/mergeGeometry'
import { fractureGeometry, sourceOf, type Fragment } from '../three/fracture'
import { createFractureClient, type FractureClient } from '../three/fractureClient'
import { createHologramMaterial } from '../three/hologramMaterial'
import { CarryPhysics, type FallTrack } from '../three/carry'
import { SocketVisibility, surfaceSamples } from '../three/visibility'
import { playImpact, playScatter, setMuted, unlockAudio } from '../audio/sfx'
import type { BenchState } from './Workshop'
import {
  artifactUrl,
  crateSpot,
  pedestalRadius,
  type ArtifactDef,
  type Phase,
  type PieceState,
  type Settings,
} from '../artifact'

const TARGET_HEIGHT = 6
const FLIGHT = 0.75
const SPILL = 0.9
/** Радиус зоны дробления вокруг удара — доля от приведённого размера экспоната. */
const BREAK_RADIUS = TARGET_HEIGHT * 0.42
/**
 * Какая доля гнезда должна быть видна с камеры, чтобы черепок на него встал.
 * Замер на кратере: передние и боковые гнёзда видны на 49–100%, задние на 0–18%
 * (эти 18% — внутренняя стенка, видная сверху поверх края).
 */
const VISIBLE_SHARE = 0.3

export type Piece = {
  fragment: Fragment
  state: PieceState
  scatterPos: THREE.Vector3
  scatterQuat: THREE.Quaternion
}

export type Progress = {
  total: number
  placed: number
  lost: number
  done: boolean
}

type Props = {
  def: ArtifactDef
  settings: Settings
  hintLevel: number
  selectedId: number | null
  onSelect: (id: number | null) => void
  onProgress: (p: Progress) => void
  onWrong: () => void
  onSize: (height: number, radius: number) => void
  revealAll: number
  phase: Phase
  onPhase: (p: Phase) => void
  onStability: (v: number) => void
  /** Находка ударилась о пол — ровно один раз за падение. */
  onImpact: () => void
  /** Черепок подведён к гнезду, которое с этого ракурса не видно. */
  onBackside: (hidden: boolean) => void
  bench: BenchState
}

type Spill = { t: number; from: THREE.Vector3; quat: THREE.Quaternion; arc: number }

const IDENTITY = new THREE.Quaternion()
const pointerNdc = new THREE.Vector2()
const hitPoint = new THREE.Vector3()
const planeNormal = new THREE.Vector3()
const homeProbe = new THREE.Vector3()
const curProbe = new THREE.Vector3()
const negCenter = new THREE.Vector3()
const panProbe = new THREE.Vector3()
const restBox = new THREE.Box3()
const restMatrix = new THREE.Matrix4()
const poseA = new THREE.Quaternion()
const poseB = new THREE.Quaternion()
// горизонтальная плоскость, по которой водят находку при переносе
const carryPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

const selectionMaterial = new THREE.MeshBasicMaterial({
  color: '#ffd479',
  transparent: true,
  opacity: 0.35,
  side: THREE.BackSide,
  depthWrite: false,
})

export function Artifact({
  def,
  settings,
  hintLevel,
  selectedId,
  onSelect,
  onProgress,
  onWrong,
  onSize,
  revealAll,
  phase,
  onPhase,
  onStability,
  onImpact,
  onBackside,
  bench,
}: Props) {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const raycaster = useThree((s) => s.raycaster)
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null
  const ktx2 = useMemo(
    () => new KTX2Loader().setTranscoderPath(import.meta.env.BASE_URL + 'basis/').detectSupport(gl),
    [gl],
  )
  const { scene } = useGLTF(artifactUrl(def), true, true, (loader) => loader.setKTX2Loader(ktx2))

  // Скан приводится к общему масштабу ДО раскола — тогда «родное» место
  // каждого черепка это единичная матрица, и собранный экспонат сходится сам.
  const scan = useMemo(() => {
    const merged = mergeSceneGeometry(scene)
    const geo = merged.geometry
    const box = geo.boundingBox ?? new THREE.Box3()
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const k = TARGET_HEIGHT / Math.max(size.x, size.y, size.z)
    geo.translate(-center.x, -box.min.y, -center.z)
    geo.scale(k, k, k)
    geo.computeBoundingBox()
    geo.computeBoundingSphere()
    return merged
  }, [scene])

  const size = useMemo(() => {
    const box = scan.geometry.boundingBox ?? new THREE.Box3()
    const s = box.getSize(new THREE.Vector3())
    return { height: s.y, radius: Math.max(s.x, s.z) / 2 }
  }, [scan])

  useEffect(() => onSize(size.height, size.radius), [size, onSize])

  /**
   * Раскол. Пока находку не уронили, он один и тот же при каждом запуске:
   * посетитель и экскурсовод видят одну задачу. Считается прямо при загрузке —
   * всё равно под экраном загрузки. Раскол от удара приходит из воркера и
   * заменяет черепки и раскладку одним обновлением.
   */
  const initial = useMemo(() => {
    const fragments = fractureGeometry(scan.geometry, def.pieces, 7, scan.triMaterial)
    return { fragments, pieces: layoutPieces(fragments, def.lostShare, size.radius, 0) }
  }, [scan, def.pieces, def.lostShare, size.radius])

  const [fragments, setFragments] = useState(initial.fragments)
  const [pieces, setPieces] = useState(initial.pieces)

  useEffect(() => () => fragments.forEach((f) => f.geometry.dispose()), [fragments])

  // Материал скана — им рисуются уцелевшие черепки.
  const realMaterials = useMemo(() => {
    const list = scan.materials.length ? scan.materials : [new THREE.MeshStandardMaterial({ color: '#b9a88c' })]
    return list.map((m) => {
      const clone = m.clone()
      clone.side = THREE.DoubleSide
      return clone
    })
  }, [scan])

  // Каждому черепку своя голограмма: у них разная подсветка и фаза материализации.
  const ghostMaterials = useMemo(
    () =>
      fragments.map(() => {
        const m = createHologramMaterial()
        m.uniforms.uHeight.value = size.height
        m.uniforms.uMinY.value = 0
        return m
      }),
    [fragments, size.height],
  )

  useEffect(() => () => ghostMaterials.forEach((m) => m.dispose()), [ghostMaterials])

  // геометрия черепка разбита на группы по материалам — голограмме нужен
  // массив той же длины, иначе часть треугольников останется без материала
  const ghostSlots = useMemo(
    () => ghostMaterials.map((m) => realMaterials.map(() => m)),
    [ghostMaterials, realMaterials],
  )

  const flights = useRef(new Map<number, number>())
  const spills = useRef(new Map<number, Spill>())
  const groupRefs = useRef(new Map<number, THREE.Group>())

  // «Показать результат» — расставляем всё разом.
  useEffect(() => {
    if (!revealAll) return
    spills.current.clear()
    setPieces((prev) => prev.map((p) => (p.state === 'loose' ? { ...p, state: 'placed' } : p)))
    onSelect(null)
  }, [revealAll, onSelect])

  useEffect(() => {
    const placed = pieces.filter((p) => p.state === 'placed').length
    const lost = pieces.filter((p) => p.state === 'lost').length
    const total = pieces.length - lost
    onProgress({ total, placed, lost, done: total > 0 && placed === total })
  }, [pieces, onProgress])

  useEffect(() => setMuted(!settings.sound), [settings.sound])

  // ---- перенос находки из ящика на подставку ----
  const pivotY = size.height * 0.5
  const carryY = pivotY + size.height * 0.28
  const crate = useMemo(() => crateSpot(size.radius), [size.radius])
  const snap = useMemo(() => pedestalRadius(size.radius) * 0.95, [size.radius])

  const carryRoot = useRef<THREE.Group>(null)
  const carryInner = useRef<THREE.Group>(null)
  const carry = useRef<CarryPhysics | null>(null)
  const held = useRef(false)
  const aim = useRef(new THREE.Vector3())
  const grabOff = useRef(new THREE.Vector3())
  const lastStab = useRef(-1)
  // падение, просчитанное в момент срыва, и черепки, которые воркер для него готовит
  const fall = useRef<{ track: FallTrack; t: number; landed: boolean; seed: number } | null>(null)
  const broken = useRef<Fragment[] | null>(null)
  // откуда разлетаются черепки: где находка лежит после удара или стоит на подставке
  const spillFrom = useRef({ pos: new THREE.Vector3(), quat: new THREE.Quaternion() })
  const [shock, setShock] = useState<{ x: number; z: number } | null>(null)

  const startPos = useMemo<[number, number, number]>(() => [crate[0], pivotY, crate[2]], [crate, pivotY])
  const innerPos = useMemo<[number, number, number]>(() => [0, -pivotY, 0], [pivotY])

  useEffect(() => {
    carry.current = new CarryPhysics(new THREE.Vector3(crate[0], pivotY, crate[2]))
  }, [crate, pivotY])

  const fracturer = useRef<FractureClient | null>(null)
  useEffect(() => {
    const client = createFractureClient(sourceOf(scan.geometry, scan.triMaterial))
    fracturer.current = client
    return () => {
      client.dispose()
      fracturer.current = null
    }
  }, [scan])

  /**
   * Точки с прореживанием — по ним ищем, чем именно находка ударилась о пол.
   * Берём только уцелевшие черепки: утраченное существует лишь как проекция,
   * и удариться о пол им нечем. Иначе густые трещины уходили бы в голограмму,
   * а настоящие черепки зависали бы над полом.
   */
  const probe = useMemo(() => {
    const real = pieces.filter((p) => p.state !== 'lost').map((p) => p.fragment.geometry.getAttribute('position'))
    const total = real.reduce((n, a) => n + a.count, 0)
    const stride = Math.max(1, Math.floor(total / 2500))
    const out = new Float32Array((Math.ceil(total / stride) + real.length) * 3)
    let k = 0
    for (const pos of real) {
      for (let i = 0; i < pos.count; i += stride) {
        out[k++] = pos.getX(i)
        out[k++] = pos.getY(i)
        out[k++] = pos.getZ(i)
      }
    }
    return out.subarray(0, k)
  }, [pieces])

  // ---- видимость гнёзд ----
  const visibility = useMemo(() => new SocketVisibility(gl, scan.geometry), [gl, scan])
  useEffect(() => {
    visibility.warmUp(camera)
    return () => visibility.dispose()
  }, [visibility, camera])

  const samples = useMemo(() => fragments.map((f) => surfaceSamples(f.geometry)), [fragments])
  const socketVisible = useCallback(
    (id: number) => {
      const s = samples[id]
      return !!s && visibility.fraction(s, camera) >= VISIBLE_SHARE
    },
    [samples, visibility, camera],
  )

  const backside = useRef(false)
  const reportBackside = useCallback(
    (hidden: boolean) => {
      if (backside.current === hidden) return
      backside.current = hidden
      onBackside(hidden)
    },
    [onBackside],
  )

  const panOf = useCallback(
    (p: THREE.Vector3) => THREE.MathUtils.clamp(panProbe.copy(p).project(camera).x, -1, 1),
    [camera],
  )

  // Фаза из App приходит через DOM-корень React, а черепки живут в корне r3f, и
  // коммиты этих корней не совпадают. Если ждать фазу оттуда, новые черепки на кадр
  // встанут в старую фазу — целой вазой. Поэтому переход к реставрации отмечаем здесь,
  // в одном обновлении с черепками.
  const [repairing, setRepairing] = useState(false)
  const inRepair = repairing || phase === 'repair'
  const carrying = !inRepair && (phase === 'carry' || phase === 'falling')
  const interactive = inRepair

  const startCarry = useCallback(
    (clientX: number, clientY: number) => {
      const c = carry.current
      if (!c || c.falling || fall.current) return
      unlockAudio()
      carryPlane.constant = -carryY
      const rect = gl.domElement.getBoundingClientRect()
      pointerNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(pointerNdc, camera)
      if (!raycaster.ray.intersectPlane(carryPlane, hitPoint)) return

      // запоминаем, за какое место взяли: иначе находка прыгнет под курсор
      grabOff.current.set(c.pos.x - hitPoint.x, 0, c.pos.z - hitPoint.z)
      aim.current.set(c.pos.x, carryY, c.pos.z)
      held.current = true
      if (controls) controls.enabled = false
      document.body.style.cursor = 'grabbing'
    },
    [carryY, gl, raycaster, camera, controls],
  )

  const arrive = useCallback(() => {
    const c = carry.current
    if (!c) return
    c.pos.set(0, pivotY, 0)
    c.vel.set(0, 0, 0)
    c.swing.set(0, 0)
    c.swingVel.set(0, 0)
    bench.over = false
    spillFrom.current.pos.set(0, pivotY, 0)
    spillFrom.current.quat.identity()
    setRepairing(true)
    onPhase('repair')
  }, [pivotY, bench, onPhase])

  /**
   * Черепки заменяют находку ровно в той позе, в которой она лежит после удара,
   * и разлетаются оттуда. Черепки, раскладка и фаза меняются одним обновлением:
   * если бы черепки успели появиться раньше, чем уедет старая находка, раскол
   * было бы видно дважды.
   */
  const shatter = useCallback(() => {
    const f = fall.current
    const next = broken.current
    const root = carryRoot.current
    if (!f || !next || !root) return
    broken.current = null
    spillFrom.current.pos.copy(root.position)
    spillFrom.current.quat.copy(root.quaternion)
    const nextPieces = layoutPieces(next, def.lostShare, size.radius, f.seed)
    setFragments(next)
    setPieces(nextPieces)
    setRepairing(true)
    onSelect(null)
    onPhase('repair')
    playScatter(nextPieces.filter((p) => p.state !== 'lost').length, panOf(root.position))
  }, [def.lostShare, size.radius, onSelect, onPhase, panOf])

  // Подсказка: первый уровень сужает до трёх гнёзд, второй показывает нужное.
  const hinted = useMemo(() => {
    if (selectedId === null || hintLevel === 0) return new Set<number>()
    if (hintLevel >= 2) return new Set([selectedId])
    const rng = seeded(selectedId + 101)
    const decoys = pieces
      .filter((p) => p.state === 'loose' && p.fragment.id !== selectedId)
      .map((p) => p.fragment.id)
      .sort(() => rng() - 0.5)
      .slice(0, 2)
    return new Set([selectedId, ...decoys])
  }, [selectedId, hintLevel, pieces])

  const handleSocketClick = useCallback(
    (socketId: number) => {
      if (selectedId === null) return
      // гнездо за вазой не принимает ни верный черепок, ни ошибку: его просто не видно
      if (!socketVisible(socketId)) return
      if (socketId !== selectedId) {
        onWrong()
        return
      }
      flights.current.set(socketId, 0)
      spills.current.delete(socketId)
      const ghost = ghostMaterials[socketId]
      if (ghost) ghost.uniforms.uAssemble.value = 0
      setPieces((prev) => prev.map((p) => (p.fragment.id === socketId ? { ...p, state: 'placed' } : p)))
      onSelect(null)
    },
    [selectedId, onSelect, onWrong, ghostMaterials, socketVisible],
  )

  // ---- перетаскивание черепка мышью ----
  const drag = useRef<{
    id: number
    plane: THREE.Plane
    offset: THREE.Vector3
    moved: boolean
  } | null>(null)
  // черепок у самого гнезда — подсвечиваем его и защёлкиваем по отпусканию
  const nearHome = useRef<number | null>(null)

  /**
   * Близость считаем НА ЭКРАНЕ, а не в мире. Тянем мы по плоскости, обращённой
   * к камере, то есть глубина остаётся той, на которой черепок подняли, — и до
   * «настоящих» координат гнезда дотянуться почти невозможно. А вот подвести
   * черепок к дыре так, чтобы он её закрыл, естественно и получается с любого ракурса.
   *
   * Но экран плоский: заднее гнездо проецируется в тот же силуэт, что и переднее.
   * Поэтому рядом на экране — ещё не повод защёлкнуть: гнездо должно быть видно.
   */
  const homeState = useCallback(
    (id: number, group: THREE.Group): 'far' | 'near' | 'hidden' => {
      const piece = pieces.find((p) => p.fragment.id === id)
      if (!piece) return 'far'
      // Раньше здесь стояла отсечка «далеко в мире — не попадание». Она грубо ловила
      // заднюю сторону, но заодно молча отказывала видимым гнёздам: черепок тянется
      // на той глубине, где его подняли, и с дальнего края стола до гнезда больше
      // двух высот вазы. Заднюю сторону теперь честно ловит проверка видимости.

      const rect = gl.domElement.getBoundingClientRect()
      homeProbe.copy(piece.fragment.center).project(camera)
      curProbe.copy(group.position).project(camera)
      const dx = (homeProbe.x - curProbe.x) * 0.5 * rect.width
      const dy = (homeProbe.y - curProbe.y) * 0.5 * rect.height
      if (Math.hypot(dx, dy) >= Math.min(rect.width, rect.height) * 0.07) return 'far'
      return socketVisible(id) ? 'near' : 'hidden'
    },
    [pieces, gl, camera, socketVisible],
  )

  const pointerToWorld = useCallback(
    (clientX: number, clientY: number, plane: THREE.Plane, out: THREE.Vector3) => {
      const rect = gl.domElement.getBoundingClientRect()
      pointerNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(pointerNdc, camera)
      return raycaster.ray.intersectPlane(plane, out)
    },
    [gl, camera, raycaster],
  )

  const endDrag = useCallback(() => {
    const active = drag.current
    drag.current = null
    if (controls) controls.enabled = true
    document.body.style.cursor = 'auto'
    reportBackside(false)
    if (!active) return

    const group = groupRefs.current.get(active.id)
    if (!group) return

    // у своего видимого гнезда — защёлкиваем, иначе черепок остаётся где брошен
    if (homeState(active.id, group) === 'near') {
      flights.current.set(active.id, 0)
      const ghost = ghostMaterials[active.id]
      if (ghost) ghost.uniforms.uAssemble.value = 0
      setPieces((prev) =>
        prev.map((p) =>
          p.fragment.id === active.id
            ? { ...p, state: 'placed', scatterPos: group.position.clone(), scatterQuat: IDENTITY.clone() }
            : p,
        ),
      )
    } else {
      const piece = pieces.find((p) => p.fragment.id === active.id)
      const dropped = group.position.clone()
      if (piece) dropped.y = Math.max(dropped.y, restY(piece.fragment, group.quaternion))
      setPieces((prev) =>
        prev.map((p) =>
          p.fragment.id === active.id ? { ...p, scatterPos: dropped, scatterQuat: IDENTITY.clone() } : p,
        ),
      )
    }
    nearHome.current = null
  }, [controls, ghostMaterials, homeState, pieces, reportBackside])

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (held.current) {
        carryPlane.constant = -carryY
        if (pointerToWorld(e.clientX, e.clientY, carryPlane, hitPoint)) {
          aim.current.set(hitPoint.x + grabOff.current.x, carryY, hitPoint.z + grabOff.current.z)
        }
        return
      }
      const active = drag.current
      if (!active) return
      const group = groupRefs.current.get(active.id)
      if (!group) return
      if (pointerToWorld(e.clientX, e.clientY, active.plane, hitPoint)) {
        group.position.copy(hitPoint).add(active.offset)
        active.moved = true
        const state = homeState(active.id, group)
        nearHome.current = state === 'near' ? active.id : null
        reportBackside(state === 'hidden')
      }
    }
    const up = () => {
      if (held.current) {
        // отпустили: находка садится на стол там, где её оставили
        held.current = false
        if (controls) controls.enabled = true
        document.body.style.cursor = 'auto'
        return
      }
      endDrag()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [pointerToWorld, endDrag, homeState, reportBackside, carryY, controls])

  const startDrag = useCallback(
    (id: number, clientX: number, clientY: number) => {
      const group = groupRefs.current.get(id)
      if (!group) return
      // тянем по плоскости, обращённой к камере: черепок идёт ровно за курсором
      camera.getWorldDirection(planeNormal)
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal.negate(), group.position)
      if (!pointerToWorld(clientX, clientY, plane, hitPoint)) return

      // разворачиваем черепок «как надо»: искать место и так непросто,
      // подбирать ещё и поворот — уже издевательство
      group.quaternion.copy(IDENTITY)
      spills.current.delete(id)
      drag.current = { id, plane, offset: group.position.clone().sub(hitPoint), moved: false }
      if (controls) controls.enabled = false
      document.body.style.cursor = 'grabbing'
      onSelect(id)
    },
    [camera, controls, pointerToWorld, onSelect],
  )

  /**
   * Рассыпаем находку по столу ровно один раз при входе в реставрацию.
   * Layout-эффект, а не обычный: стартовые позы нужно выставить до ближайшего
   * кадра, иначе черепки на кадр мелькнут уже разложенными по столу.
   */
  const spilled = useRef(false)
  useLayoutEffect(() => {
    if (!inRepair) {
      spilled.current = false
      return
    }
    if (spilled.current) return
    spilled.current = true
    spills.current.clear()

    carryRoot.current?.position.set(0, 0, 0)
    carryRoot.current?.quaternion.identity()
    carryInner.current?.position.set(0, 0, 0)

    const { pos, quat } = spillFrom.current
    pieces.forEach((p, i) => {
      if (p.state !== 'loose') return
      // где этот черепок был в целой находке, пока она лежала или стояла
      const from = p.fragment.center.clone().setY(p.fragment.center.y - pivotY).applyQuaternion(quat).add(pos)
      const arc = Math.min(size.height * 0.35, 0.3 + from.distanceTo(p.scatterPos) * 0.1)
      spills.current.set(p.fragment.id, { t: -i * 0.03, from, quat: quat.clone(), arc })
      const g = groupRefs.current.get(p.fragment.id)
      if (g) {
        g.position.copy(from)
        g.quaternion.copy(quat)
      }
    })
  }, [inRepair, pieces, pivotY, size.height])

  useFrame((state, delta) => {
    // не больше 50 мс (вкладка просыпалась) и не меньше нуля (часы сдвинули назад)
    const dt = Math.max(0, Math.min(delta, 0.05))
    const t = state.clock.elapsedTime

    ghostMaterials.forEach((mat, id) => {
      mat.uniforms.uTime.value = t
      mat.uniforms.uHighlight.value = THREE.MathUtils.damp(
        mat.uniforms.uHighlight.value,
        hinted.has(id) || nearHome.current === id ? 1 : 0,
        8,
        dt,
      )
    })

    const root = carryRoot.current
    const c = carry.current
    if (carrying && root && c) {
      const f = fall.current
      if (!f) {
        c.step(dt, held.current ? aim.current : null, pivotY)
        root.position.copy(c.pos)
        c.quaternion(root.quaternion)

        const rounded = Math.round(c.stability * 100) / 100
        if (rounded !== lastStab.current) {
          lastStab.current = rounded
          onStability(rounded)
        }

        if (c.falling) {
          // Сорвалась. Дальше рук нет, только гравитация — падение известно целиком.
          // Раскол начинаем считать сразу, пока находка ещё летит.
          held.current = false
          bench.over = false
          if (controls) controls.enabled = true
          document.body.style.cursor = 'auto'

          const track = c.simulateFall(probe, pivotY)
          const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0
          fall.current = { track, t: 0, landed: false, seed }
          onPhase('falling')

          const [x, y, z] = track.contact
          fracturer.current
            ?.fracture(def.pieces + def.brokenExtra, seed, { x, y, z, radius: BREAK_RADIUS })
            .then((result) => {
              if (fall.current?.seed !== seed) {
                result.forEach((r) => r.geometry.dispose())
                return
              }
              broken.current = result
              // воркер не успел к удару — находка лежит, пока не придут черепки
              if (fall.current.landed) shatter()
            })
        } else if (phase === 'carry') {
          bench.over = held.current && Math.hypot(c.pos.x, c.pos.z) < snap
          if (
            !held.current &&
            Math.hypot(c.pos.x, c.pos.z) < snap &&
            c.vel.lengthSq() < 0.09 &&
            Math.abs(c.pos.y - pivotY) < 0.12
          ) {
            arrive()
          }
        }
      } else if (!f.landed) {
        // проигрываем просчитанное падение
        f.t += dt
        const last = f.track.steps - 1
        const x = Math.max(0, Math.min(last, f.t / f.track.step))
        const i = Math.floor(x)
        const j = Math.min(last, i + 1)
        const u = x - i
        const P = f.track.poses
        root.position.set(
          P[i * 7] + (P[j * 7] - P[i * 7]) * u,
          P[i * 7 + 1] + (P[j * 7 + 1] - P[i * 7 + 1]) * u,
          P[i * 7 + 2] + (P[j * 7 + 2] - P[i * 7 + 2]) * u,
        )
        poseA.set(P[i * 7 + 3], P[i * 7 + 4], P[i * 7 + 5], P[i * 7 + 6])
        poseB.set(P[j * 7 + 3], P[j * 7 + 4], P[j * 7 + 5], P[j * 7 + 6])
        root.quaternion.slerpQuaternions(poseA, poseB, u)

        if (x >= last) {
          f.landed = true
          const [wx, , wz] = f.track.contactWorld
          setShock({ x: wx, z: wz })
          playImpact(1, panOf(panProbe.set(wx, 0, wz)))
          onImpact()
          if (broken.current) shatter()
        }
      }
    } else if (root && !carrying) {
      // реставрация идёт в координатах экспоната — контейнер переноса нейтрален
      root.position.set(0, 0, 0)
      root.quaternion.identity()
      if (carryInner.current) carryInner.current.position.set(0, 0, 0)
    }

    // Перелёт черепка в своё гнездо.
    for (const [id, progress] of flights.current) {
      const next = Math.min(1, progress + dt / FLIGHT)
      flights.current.set(id, next)

      const group = groupRefs.current.get(id)
      const piece = pieces.find((p) => p.fragment.id === id)
      if (group && piece) {
        const eased = 1 - Math.pow(1 - next, 3)
        group.position.lerpVectors(piece.scatterPos, piece.fragment.center, eased)
        group.quaternion.slerpQuaternions(piece.scatterQuat, IDENTITY, eased)
      }

      const ghost = ghostMaterials[id]
      if (ghost) ghost.uniforms.uAssemble.value = next
      if (next >= 1) flights.current.delete(id)
    }

    // Разлёт: черепки уезжают оттуда, где была находка, по своим местам на столе.
    // Пока черепок ждёт своей очереди, он держит стартовую позу, а не лежит на месте.
    for (const [id, s] of spills.current) {
      s.t += dt / SPILL
      const group = groupRefs.current.get(id)
      const piece = pieces.find((p) => p.fragment.id === id)
      if (group && piece) {
        const eased = 1 - Math.pow(1 - Math.min(1, Math.max(0, s.t)), 3)
        group.position.lerpVectors(s.from, piece.scatterPos, eased)
        group.position.y += Math.sin(eased * Math.PI) * s.arc
        group.quaternion.slerpQuaternions(s.quat, piece.scatterQuat, eased)
      }
      if (s.t >= 1) spills.current.delete(id)
    }
  })

  return (
    <group>
      <group ref={carryRoot} position={startPos}>
        <group ref={carryInner} position={innerPos}>
          {pieces.map((piece) => {
            const id = piece.fragment.id
            const flying = flights.current.has(id)
            // во время переноса находка целая: все черепки стоят по местам
            const isPlaced = carrying || piece.state === 'placed'
            const isLost = piece.state === 'lost'
            const isSelected = selectedId === id

            // Голограмма — это либо утраченный черепок, либо пустое гнездо,
            // либо рентген уже собранного.
            const showGhost =
              (isLost && settings.showReconstruction) || (!isLost && !isPlaced) || (isPlaced && settings.xray)

            return (
              <group key={id}>
                {showGhost && (
                  <mesh
                    geometry={piece.fragment.geometry}
                    material={ghostSlots[id]}
                    renderOrder={2}
                    onClick={(e) => {
                      if (!interactive || isLost || isPlaced || selectedId === null) return
                      e.stopPropagation()
                      handleSocketClick(id)
                    }}
                  />
                )}

                {!isLost && (
                  <group
                    ref={(g) => {
                      if (g) groupRefs.current.set(id, g)
                    }}
                    position={isPlaced && !flying ? piece.fragment.center : piece.scatterPos}
                    quaternion={isPlaced && !flying ? IDENTITY : piece.scatterQuat}
                  >
                    <mesh
                      geometry={piece.fragment.geometry}
                      position={pieceOffset(piece.fragment)}
                      material={realMaterials}
                      visible={!(isPlaced && settings.xray)}
                      castShadow
                      receiveShadow
                      onPointerDown={(e) => {
                        if (carrying && phase === 'carry') {
                          e.stopPropagation()
                          startCarry(e.clientX, e.clientY)
                          return
                        }
                        if (!interactive || isPlaced) return
                        e.stopPropagation()
                        startDrag(id, e.clientX, e.clientY)
                      }}
                      onClick={(e) => {
                        if (!interactive || isPlaced) return
                        e.stopPropagation()
                        // клик без перетаскивания — просто выбор, чтобы работала подсказка
                        if (!drag.current?.moved) onSelect(isSelected && drag.current === null ? null : id)
                      }}
                      onPointerOver={() => {
                        if (carrying && phase === 'carry')
                          document.body.style.cursor = held.current ? 'grabbing' : 'grab'
                        else if (interactive && !isPlaced)
                          document.body.style.cursor = drag.current ? 'grabbing' : 'grab'
                      }}
                      onPointerOut={() => {
                        if (!drag.current && !held.current) document.body.style.cursor = 'auto'
                      }}
                    />
                    {isSelected && !isPlaced && (
                      <mesh
                        geometry={piece.fragment.geometry}
                        position={pieceOffset(piece.fragment)}
                        material={selectionMaterial}
                        scale={1.02}
                      />
                    )}
                  </group>
                )}
              </group>
            )
          })}
        </group>
      </group>

      <Shockwave at={shock} />
    </group>
  )
}

/** Волна по полу там, где находка ударилась. */
function Shockwave({ at }: { at: { x: number; z: number } | null }) {
  const mesh = useRef<THREE.Mesh>(null)
  const mat = useRef<THREE.MeshBasicMaterial>(null)
  const age = useRef(Infinity)

  useEffect(() => {
    if (at) age.current = 0
  }, [at])

  useFrame((_, delta) => {
    const m = mesh.current
    if (!m || !mat.current) return
    age.current += Math.min(delta, 0.05)
    const k = age.current / 1.1
    m.visible = k < 1
    if (!m.visible) return
    const s = 0.4 + k * 5
    m.scale.set(s, s, s)
    mat.current.opacity = (1 - k) * (1 - k) * 0.85
  })

  return (
    <mesh
      ref={mesh}
      position={at ? [at.x, 0.04, at.z] : [0, 0.04, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      visible={false}
      raycast={() => null}
    >
      <ringGeometry args={[0.62, 1, 56]} />
      <meshBasicMaterial ref={mat} color="#ffd479" transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}

/**
 * Высота, на которой ПОВЁРНУТЫЙ черепок лежит на столе.
 *
 * Меш сдвинут на −center, поэтому группа вращает черепок вокруг него самого,
 * а не вокруг начала координат вазы. Значит и нижнюю точку надо считать
 * по уже повёрнутой габаритной коробке, иначе осколок уйдёт под пол.
 */
function restY(fragment: Fragment, quat: THREE.Quaternion) {
  const box = fragment.geometry.boundingBox
  if (!box) return 0.03
  restMatrix.makeRotationFromQuaternion(quat)
  restBox.copy(box).translate(negCenter.copy(fragment.center).negate()).applyMatrix4(restMatrix)
  return -restBox.min.y + 0.03
}

/** Раскладка: часть черепков «не найдена», остальные лягут вокруг подставки. */
function layoutPieces(fragments: Fragment[], lostShare: number, radius: number, seed: number): Piece[] {
  const rng = seeded(11 + seed)
  const lostCount = Math.max(1, Math.round(fragments.length * lostShare))
  const shuffled = fragments.map((_, i) => i).sort(() => rng() - 0.5)
  const lost = new Set(shuffled.slice(0, lostCount))
  const ring = Math.max(radius * 3.1, 5.2)
  // сектор, где стоит ящик, пропускаем: черепок в ящике выглядит как недоразобранная посылка
  const [cx, , cz] = crateSpot(radius)
  const gap = THREE.MathUtils.degToRad(70)
  const from = Math.atan2(cz, cx) + gap / 2
  const span = Math.PI * 2 - gap

  return fragments.map((fragment, i) => {
    const angle = from + ((i + rng() * 0.6) / fragments.length) * span
    const r = ring * (0.85 + rng() * 0.45)
    const quat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(rng() * Math.PI, rng() * Math.PI * 2, rng() * Math.PI),
    )
    return {
      fragment,
      state: (lost.has(i) ? 'lost' : 'loose') as PieceState,
      scatterPos: new THREE.Vector3(Math.cos(angle) * r, restY(fragment, quat), Math.sin(angle) * r),
      scatterQuat: quat,
    }
  })
}

/**
 * Смещение меша внутри группы: центроид черепка становится точкой вращения.
 * Ключ — сам фрагмент, а не его номер: после нового раскола номера повторяются,
 * а центры у них уже другие.
 */
const offsets = new WeakMap<Fragment, [number, number, number]>()
function pieceOffset(f: Fragment): [number, number, number] {
  let o = offsets.get(f)
  if (!o) {
    o = [-f.center.x, -f.center.y, -f.center.z]
    offsets.set(f, o)
  }
  return o
}

/** Детерминированный ГПСЧ: раскладка одинакова при каждом запуске. */
function seeded(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
