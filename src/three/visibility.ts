import * as THREE from 'three'

/**
 * Какая доля гнезда видна с текущего ракурса.
 *
 * Без этого черепок с обратной стороны вазы можно было поставить, глядя спереди:
 * близость считается на экране, а на экране заднее гнездо проецируется прямо
 * в силуэт вазы.
 *
 * Как устроено: раз на ракурс весь скан рисуется в маленькую карту расстояний
 * до камеры (четверть кадра). Дальше проверка гнезда — это сравнить расстояние
 * до его точек с тем, что лежит в карте: если перед точкой ближе есть
 * поверхность, точка закрыта. Камера на время перетаскивания стоит, поэтому
 * карта перерисовывается только когда ракурс сменился.
 *
 * Рисуется весь скан, включая утраченные куски: «обратная сторона» — свойство
 * формы вазы, а не того, что уже собрано. Иначе в начале, пока всё пусто,
 * задние гнёзда снова были бы видны насквозь.
 */

const RANGE = 200 // дальше камера не отъезжает: расстояние пакуется в 16 бит на этот диапазон
const SCALE = 4 // карта в четверть кадра: гнездо — это десятки пикселей, точнее не нужно

export class SocketVisibility {
  private readonly scene = new THREE.Scene()
  private readonly material: THREE.ShaderMaterial
  private target: THREE.WebGLRenderTarget | null = null
  private pixels = new Uint8Array(0)
  private w = 0
  private h = 0
  private readonly lastCamera = new Float64Array(18)
  private valid = false
  private readonly gl: THREE.WebGLRenderer

  constructor(gl: THREE.WebGLRenderer, occluder: THREE.BufferGeometry) {
    this.gl = gl
    this.material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { uRange: { value: RANGE } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uRange;
        varying vec3 vWorld;
        void main() {
          float d = clamp(distance(cameraPosition, vWorld) / uRange, 0.0, 1.0);
          float q = floor(d * 65534.0) + 1.0; // ноль оставлен под «здесь пусто»
          gl_FragColor = vec4(floor(q / 256.0) / 255.0, mod(q, 256.0) / 255.0, 0.0, 1.0);
        }`,
    })
    const mesh = new THREE.Mesh(occluder, this.material)
    mesh.frustumCulled = false
    this.scene.add(mesh)
  }

  /** Компилирует шейдер заранее — иначе первое касание черепка подтормозит. */
  warmUp(camera: THREE.Camera) {
    this.gl.compile(this.scene, camera)
  }

  /** Доля точек гнезда, которые видно с камеры: 0..1. */
  fraction(samples: Float32Array, camera: THREE.PerspectiveCamera) {
    this.ensure(camera)
    const { w, h } = this
    const cam = camera.position
    let visible = 0
    let total = 0
    for (let i = 0; i < samples.length; i += 3) {
      total++
      probe.set(samples[i], samples[i + 1], samples[i + 2])
      const dist = probe.distanceTo(cam)
      probe.project(camera)
      if (probe.z > 1 || Math.abs(probe.x) > 1 || Math.abs(probe.y) > 1) continue
      const sx = Math.min(w - 1, Math.floor((probe.x * 0.5 + 0.5) * w))
      const sy = Math.min(h - 1, Math.floor((probe.y * 0.5 + 0.5) * h))
      // берём самое дальнее в окрестности 3×3: на краях силуэта маленькая
      // карта путает гнездо с соседней поверхностью, пусть лучше простит
      let far = 0
      for (let dy = -1; dy <= 1; dy++) {
        const y = sy + dy
        if (y < 0 || y >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const x = sx + dx
          if (x < 0 || x >= w) continue
          far = Math.max(far, this.depthAt(x, y))
        }
      }
      if (dist <= far + 0.05 + dist * 0.004) visible++
    }
    return total ? visible / total : 0
  }

  dispose() {
    this.target?.dispose()
    this.material.dispose()
  }

  private depthAt(x: number, y: number) {
    const i = (y * this.w + x) * 4
    const q = this.pixels[i] * 256 + this.pixels[i + 1]
    return q === 0 ? Infinity : ((q - 1) / 65534) * RANGE
  }

  private ensure(camera: THREE.PerspectiveCamera) {
    const canvas = this.gl.domElement
    const w = Math.max(64, Math.round(canvas.clientWidth / SCALE))
    const h = Math.max(64, Math.round(canvas.clientHeight / SCALE))
    if (w !== this.w || h !== this.h || !this.target) {
      this.target?.dispose()
      this.target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true })
      this.pixels = new Uint8Array(w * h * 4)
      this.w = w
      this.h = h
      this.valid = false
    }

    camera.updateMatrixWorld()
    const m = camera.matrixWorld.elements
    const p = camera.projectionMatrix.elements
    let same = this.valid
    for (let i = 0; i < 16; i++) if (this.lastCamera[i] !== m[i]) same = false
    if (this.lastCamera[16] !== p[0] || this.lastCamera[17] !== p[5]) same = false
    if (same) return

    for (let i = 0; i < 16; i++) this.lastCamera[i] = m[i]
    this.lastCamera[16] = p[0]
    this.lastCamera[17] = p[5]

    const gl = this.gl
    const prevTarget = gl.getRenderTarget()
    const prevAlpha = gl.getClearAlpha()
    gl.getClearColor(prevColor)
    gl.setRenderTarget(this.target)
    gl.setClearColor(0x000000, 0)
    gl.clear()
    gl.render(this.scene, camera)
    gl.readRenderTargetPixels(this.target, 0, 0, w, h, this.pixels)
    gl.setRenderTarget(prevTarget)
    gl.setClearColor(prevColor, prevAlpha)
    this.valid = true
  }
}

const probe = new THREE.Vector3()
const prevColor = new THREE.Color()

/** Точки поверхности черепка для проверки видимости. */
export function surfaceSamples(geometry: THREE.BufferGeometry, count = 48) {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute
  const stride = Math.max(1, Math.floor(pos.count / count))
  const out = new Float32Array(Math.ceil(pos.count / stride) * 3)
  let k = 0
  for (let i = 0; i < pos.count; i += stride) {
    out[k++] = pos.getX(i)
    out[k++] = pos.getY(i)
    out[k++] = pos.getZ(i)
  }
  return out.subarray(0, k)
}
