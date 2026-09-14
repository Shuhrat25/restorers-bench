import * as THREE from 'three'

/**
 * Сливает меши объекта в один буфер, сохраняя UV — они нужны, чтобы уцелевшие
 * черепки рисовались родной текстурой скана, а не голограммой.
 *
 * Один проход в заранее выделенные массивы. Матрица применяется вручную:
 * `applyMatrix4` по нормализованным Int16-позициям (KHR_mesh_quantization)
 * писал бы дробные значения в целочисленный массив и рвал модель.
 */
export type MergedScan = {
  geometry: THREE.BufferGeometry
  /** Материалы скана в порядке индексов. */
  materials: THREE.Material[]
  /** Индекс материала для каждого треугольника — по нему черепок собирает группы. */
  triMaterial: Uint8Array
}

export function mergeSceneGeometry(root: THREE.Object3D): MergedScan {
  root.updateWorldMatrix(true, true)
  const toRootParent = new THREE.Matrix4()
  if (root.parent) {
    root.parent.updateWorldMatrix(true, false)
    toRootParent.copy(root.parent.matrixWorld).invert()
  }

  type Part = {
    geometry: THREE.BufferGeometry
    matrix: THREE.Matrix4
    normalMatrix: THREE.Matrix3
    vertexCount: number
    indexCount: number
    material: number
  }

  const parts: Part[] = []
  const materials: THREE.Material[] = []
  const materialIndex = new Map<THREE.Material, number>()
  let vertexTotal = 0
  let indexTotal = 0

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    const position = mesh.geometry.getAttribute('position')
    if (!position) return

    const matrix = new THREE.Matrix4().multiplyMatrices(toRootParent, mesh.matrixWorld)
    const indexCount = mesh.geometry.index ? mesh.geometry.index.count : position.count
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    let mi = materialIndex.get(material)
    if (mi === undefined) {
      mi = materials.length
      materials.push(material)
      materialIndex.set(material, mi)
    }
    parts.push({
      geometry: mesh.geometry,
      matrix,
      normalMatrix: new THREE.Matrix3().getNormalMatrix(matrix),
      vertexCount: position.count,
      indexCount,
      material: mi,
    })
    vertexTotal += position.count
    indexTotal += indexCount
  })

  if (!parts.length) throw new Error('В модели нет мешей с позициями')

  const positions = new Float32Array(vertexTotal * 3)
  const normals = new Float32Array(vertexTotal * 3)
  const uvs = new Float32Array(vertexTotal * 2)
  const indices = new Uint32Array(indexTotal)
  const triMaterial = new Uint8Array(indexTotal / 3)

  let vertexOffset = 0
  let indexOffset = 0

  for (const part of parts) {
    const position = part.geometry.getAttribute('position')
    const normal = part.geometry.getAttribute('normal')
    const uv = part.geometry.getAttribute('uv')
    const m = part.matrix.elements
    const n = part.normalMatrix.elements

    for (let i = 0; i < part.vertexCount; i++) {
      const x = position.getX(i)
      const y = position.getY(i)
      const z = position.getZ(i)
      const o = (vertexOffset + i) * 3

      positions[o] = m[0] * x + m[4] * y + m[8] * z + m[12]
      positions[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
      positions[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]

      if (normal) {
        const nx = normal.getX(i)
        const ny = normal.getY(i)
        const nz = normal.getZ(i)
        const tx = n[0] * nx + n[3] * ny + n[6] * nz
        const ty = n[1] * nx + n[4] * ny + n[7] * nz
        const tz = n[2] * nx + n[5] * ny + n[8] * nz
        const lenSq = tx * tx + ty * ty + tz * tz
        const inv = lenSq > 1e-12 ? 1 / Math.sqrt(lenSq) : 0
        normals[o] = tx * inv
        normals[o + 1] = ty * inv
        normals[o + 2] = tz * inv
      }

      if (uv) {
        const u = (vertexOffset + i) * 2
        uvs[u] = uv.getX(i)
        uvs[u + 1] = uv.getY(i)
      }
    }

    const index = part.geometry.index
    if (index) {
      const src = index.array as ArrayLike<number>
      for (let i = 0; i < part.indexCount; i++) indices[indexOffset + i] = src[i] + vertexOffset
    } else {
      for (let i = 0; i < part.indexCount; i++) indices[indexOffset + i] = vertexOffset + i
    }

    triMaterial.fill(part.material, indexOffset / 3, (indexOffset + part.indexCount) / 3)

    vertexOffset += part.vertexCount
    indexOffset += part.indexCount
  }

  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  merged.setIndex(new THREE.BufferAttribute(indices, 1))
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  return { geometry: merged, materials, triMaterial }
}
