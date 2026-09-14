import * as THREE from 'three'
import { fractureArrays, type FractureSource, type FragmentData } from './fractureCore'

export type Fragment = {
  id: number
  geometry: THREE.BufferGeometry
  /** Центр масс черепка в координатах экспоната — по нему считаем разлёт и подсветку. */
  center: THREE.Vector3
  triangles: number
}

/** Удар, от которого пошли трещины: чем ближе к точке, тем мельче черепки. */
export type Impact = {
  /** Точка касания в координатах экспоната. */
  point: THREE.Vector3
  /** Радиус зоны дробления. */
  radius: number
}

/** Голые массивы скана — их можно отдать воркеру. */
export function sourceOf(geometry: THREE.BufferGeometry, triMaterial?: Uint8Array): FractureSource {
  const index = geometry.getIndex()
  if (!index) throw new Error('Ожидается индексированная геометрия')
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined
  return {
    position: (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array,
    normal: normal ? (normal.array as Float32Array) : undefined,
    uv: uv ? (uv.array as Float32Array) : undefined,
    index: index.array as Uint32Array | Uint16Array,
    triMaterial,
  }
}

/** Собирает черепки three.js из того, что вернуло ядро (в том числе из воркера). */
export function toFragments(data: FragmentData[]): Fragment[] {
  return data.map((d, id) => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(d.position, 3))
    if (d.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3))
    if (d.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2))
    geometry.setIndex(new THREE.BufferAttribute(d.index, 1))
    for (const g of d.groups) geometry.addGroup(g.start, g.count, g.material)
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return { id, geometry, center: new THREE.Vector3(...d.center), triangles: d.triangles }
  })
}

/**
 * Колет скан на черепки по диаграмме Вороного: каждый треугольник уходит
 * к ближайшему зерну. Границы получаются рваными и непредсказуемыми — именно
 * так и выглядит настоящий скол, в отличие от разреза по плоскости.
 *
 * Благодаря этому новый экспонат не требует ручной разметки: положил скан —
 * получил черепки.
 */
export function fractureGeometry(
  source: THREE.BufferGeometry,
  count: number,
  seed = 1,
  triMaterial?: Uint8Array,
  impact?: Impact | null,
): Fragment[] {
  const hit = impact ? { x: impact.point.x, y: impact.point.y, z: impact.point.z, radius: impact.radius } : null
  return toFragments(fractureArrays(sourceOf(source, triMaterial), count, seed, hit))
}
