/**
 * Раскол по Вороному на голых массивах, без three.js.
 *
 * Отдельно от обёртки он нужен ради воркера: удар случается посреди анимации,
 * и пересчёт сотен тысяч треугольников в основном потоке заморозил бы кадр ровно
 * в тот момент, когда на экран смотрят внимательнее всего.
 */

export type FractureSource = {
  position: Float32Array
  normal?: Float32Array
  uv?: Float32Array
  index: Uint32Array | Uint16Array
  /** Индекс материала на каждый треугольник. */
  triMaterial?: Uint8Array
}

/** Удар, от которого пошли трещины: чем ближе к точке, тем мельче черепки. */
export type ImpactData = { x: number; y: number; z: number; radius: number }

export type FragmentData = {
  position: Float32Array
  normal: Float32Array | null
  uv: Float32Array | null
  index: Uint32Array
  groups: { start: number; count: number; material: number }[]
  /** Центр масс черепка в координатах экспоната. */
  center: [number, number, number]
  triangles: number
}

export function fractureArrays(
  src: FractureSource,
  count: number,
  seed = 1,
  impact?: ImpactData | null,
): FragmentData[] {
  const pos = src.position
  const idx = src.index
  const triangleCount = idx.length / 3
  const vertexCount = pos.length / 3

  // --- центроиды треугольников ---
  const cx = new Float32Array(triangleCount)
  const cy = new Float32Array(triangleCount)
  const cz = new Float32Array(triangleCount)
  for (let t = 0; t < triangleCount; t++) {
    const a = idx[t * 3] * 3
    const b = idx[t * 3 + 1] * 3
    const c = idx[t * 3 + 2] * 3
    cx[t] = (pos[a] + pos[b] + pos[c]) / 3
    cy[t] = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3
    cz[t] = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3
  }

  // --- зёрна: берём случайные центроиды, потом пара шагов Ллойда для равномерности ---
  const rng = mulberry32(seed)
  const seeds = new Float32Array(count * 3)

  const toImpact = (t: number) => {
    if (!impact) return 0
    const dx = cx[t] - impact.x
    const dy = cy[t] - impact.y
    const dz = cz[t] - impact.z
    return dx * dx + dy * dy + dz * dz
  }

  for (let s = 0; s < count; s++) {
    let t = Math.floor(rng() * triangleCount)
    // Половину зёрен стягиваем к точке удара турниром: из восьми кандидатов
    // берём ближайший. Отсюда густая сеть трещин там, куда пришёлся удар,
    // и крупные куски на другом конце — как на настоящем сколе.
    if (impact && s % 2 === 0) {
      for (let k = 0; k < 7; k++) {
        const c = Math.floor(rng() * triangleCount)
        if (toImpact(c) < toImpact(t)) t = c
      }
    }
    seeds[s * 3] = cx[t]
    seeds[s * 3 + 1] = cy[t]
    seeds[s * 3 + 2] = cz[t]
  }

  // Вес растягивает метрику вокруг зерна: рядом с ударом ячейки мельче.
  // Без него шаги Ллойда уравняли бы их и вся разница в плотности пропала бы.
  const weight = new Float32Array(count).fill(1)
  const reweigh = () => {
    if (!impact) return
    const r2 = impact.radius * impact.radius
    for (let s = 0; s < count; s++) {
      const dx = seeds[s * 3] - impact.x
      const dy = seeds[s * 3 + 1] - impact.y
      const dz = seeds[s * 3 + 2] - impact.z
      weight[s] = 1 + 1.6 * Math.exp(-(dx * dx + dy * dy + dz * dz) / r2)
    }
  }
  reweigh()

  const owner = new Int32Array(triangleCount)
  for (let pass = 0; pass < 3; pass++) {
    assign(owner, triangleCount, seeds, count, cx, cy, cz, weight)
    if (pass === 2) break
    // Ллойд: зерно переезжает в центр своей ячейки
    const sx = new Float64Array(count)
    const sy = new Float64Array(count)
    const sz = new Float64Array(count)
    const n = new Int32Array(count)
    for (let t = 0; t < triangleCount; t++) {
      const o = owner[t]
      sx[o] += cx[t]
      sy[o] += cy[t]
      sz[o] += cz[t]
      n[o]++
    }
    for (let s = 0; s < count; s++) {
      if (!n[s]) continue
      seeds[s * 3] = sx[s] / n[s]
      seeds[s * 3 + 1] = sy[s] / n[s]
      seeds[s * 3 + 2] = sz[s] / n[s]
    }
    reweigh()
  }

  // --- порядок треугольников: по черепку, внутри черепка по материалу ---
  // Два устойчивых прохода подсчётом вместо обхода всей модели на каждый черепок:
  // у скана их может быть несколько, и каждый кусок обязан рисоваться своей текстурой.
  let order = new Uint32Array(triangleCount)
  if (src.triMaterial) {
    const mat = src.triMaterial
    const start = new Int32Array(257)
    for (let t = 0; t < triangleCount; t++) start[mat[t] + 1]++
    for (let m = 0; m < 256; m++) start[m + 1] += start[m]
    for (let t = 0; t < triangleCount; t++) order[start[mat[t]]++] = t
  } else {
    for (let t = 0; t < triangleCount; t++) order[t] = t
  }
  const ownerStart = new Int32Array(count + 1)
  for (let t = 0; t < triangleCount; t++) ownerStart[owner[t] + 1]++
  for (let s = 0; s < count; s++) ownerStart[s + 1] += ownerStart[s]
  const cursor = ownerStart.slice(0, count)
  const byOwner = new Uint32Array(triangleCount)
  for (let k = 0; k < triangleCount; k++) {
    const t = order[k]
    byOwner[cursor[owner[t]]++] = t
  }
  order = byOwner

  // --- собираем геометрию черепков с переиндексацией ---
  // stamp вместо очистки таблицы: так не нужно обнулять её на каждый черепок
  const remap = new Int32Array(vertexCount).fill(-1)
  const stamp = new Int32Array(vertexCount).fill(-1)
  const nrm = src.normal
  const uv = src.uv

  const fragments: FragmentData[] = []

  for (let s = 0; s < count; s++) {
    const from = ownerStart[s]
    const tris = ownerStart[s + 1] - from
    if (!tris) continue

    const fIndex = new Uint32Array(tris * 3)
    // худший случай — все вершины уникальны; лишнее отрежем в конце
    const fPos = new Float32Array(tris * 9)
    const fNrm = nrm ? new Float32Array(tris * 9) : null
    const fUv = uv ? new Float32Array(tris * 6) : null

    let vertexCursor = 0
    let indexCursor = 0
    let sumX = 0
    let sumY = 0
    let sumZ = 0

    const groups: FragmentData['groups'] = []
    let groupMaterial = -1
    let groupStart = 0

    for (let k = from; k < from + tris; k++) {
      const t = order[k]
      const mat = src.triMaterial ? src.triMaterial[t] : 0
      if (mat !== groupMaterial) {
        if (groupMaterial >= 0) groups.push({ start: groupStart, count: indexCursor - groupStart, material: groupMaterial })
        groupMaterial = mat
        groupStart = indexCursor
      }
      sumX += cx[t]
      sumY += cy[t]
      sumZ += cz[t]

      for (let j = 0; j < 3; j++) {
        const old = idx[t * 3 + j]
        if (stamp[old] !== s) {
          stamp[old] = s
          remap[old] = vertexCursor
          const a = old * 3
          const b = vertexCursor * 3
          fPos[b] = pos[a]
          fPos[b + 1] = pos[a + 1]
          fPos[b + 2] = pos[a + 2]
          if (fNrm && nrm) {
            fNrm[b] = nrm[a]
            fNrm[b + 1] = nrm[a + 1]
            fNrm[b + 2] = nrm[a + 2]
          }
          if (fUv && uv) {
            fUv[vertexCursor * 2] = uv[old * 2]
            fUv[vertexCursor * 2 + 1] = uv[old * 2 + 1]
          }
          vertexCursor++
        }
        fIndex[indexCursor++] = remap[old]
      }
    }
    if (groupMaterial >= 0) groups.push({ start: groupStart, count: indexCursor - groupStart, material: groupMaterial })

    fragments.push({
      // slice, а не subarray: иначе черепок держал бы буфер худшего случая,
      // а при передаче из воркера уехал бы весь этот буфер целиком
      position: fPos.slice(0, vertexCursor * 3),
      normal: fNrm ? fNrm.slice(0, vertexCursor * 3) : null,
      uv: fUv ? fUv.slice(0, vertexCursor * 2) : null,
      index: fIndex,
      groups,
      center: [sumX / tris, sumY / tris, sumZ / tris],
      triangles: tris,
    })
  }

  return fragments
}

function assign(
  owner: Int32Array,
  triangleCount: number,
  seeds: Float32Array,
  count: number,
  cx: Float32Array,
  cy: Float32Array,
  cz: Float32Array,
  weight: Float32Array,
) {
  for (let t = 0; t < triangleCount; t++) {
    let best = 0
    let bestDist = Infinity
    for (let s = 0; s < count; s++) {
      const dx = cx[t] - seeds[s * 3]
      const dy = cy[t] - seeds[s * 3 + 1]
      const dz = cz[t] - seeds[s * 3 + 2]
      const d = (dx * dx + dy * dy + dz * dz) * weight[s]
      if (d < bestDist) {
        bestDist = d
        best = s
      }
    }
    owner[t] = best
  }
}

/** Детерминированный ГПСЧ: одна и та же ваза колется одинаково при каждом запуске. */
function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
