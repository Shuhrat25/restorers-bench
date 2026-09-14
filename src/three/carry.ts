import * as THREE from 'three'

/**
 * Перенос находки из ящика на верстак.
 *
 * Главное здесь — что падение не случайность. Предмет висит на «руках»
 * реставратора как на пружине, и любое ускорение раскачивает его маятником.
 * Устойчивость тратится ровно на величину наклона: ведёшь ровно — не тратится
 * совсем, дёргаешь — уходит за пару секунд. Уронить можно только самому.
 */

const FOLLOW_K = 30 // жёсткость «рук»: насколько цепко предмет идёт за курсором
const FOLLOW_C = 10 // затухание рук
const SWING_K = 20 // жёсткость маятника (период качания)
const SWING_C = 1.7 // затухание качания
const SWING_GAIN = 0.18 // сколько наклона даёт единица ускорения
const SWING_MAX = 0.6 // предел наклона, рад
const TILT_SAFE = 0.05 // наклон, который проходит бесплатно (~3°)
const DRAIN = 3.4 // скорость потери устойчивости на радиан сверх безопасного
const REGAIN_HELD = 0.2 // восстановление, пока держишь ровно
const REGAIN_DOWN = 0.75 // восстановление, когда предмет поставлен на стол
const SAFE_SPEED = 6 // скорость, выше которой несёт уже слишком быстро (ед/с при высоте 6)
const SPEED_W = 0.03 // во сколько наклона обходится лишняя скорость
const GRAVITY = 17

const FALL_STEP = 1 / 60
const FALL_MAX_STEPS = 240

const acc = new THREE.Vector3()
const euler = new THREE.Euler(0, 0, 0, 'XZY')
const fallQuat = new THREE.Quaternion()
const fallMatrix = new THREE.Matrix4()

/**
 * Падение, просчитанное целиком в момент срыва. Дальше рук нет, только гравитация,
 * поэтому траектория известна заранее — и раскол можно начать считать сразу,
 * пока находка ещё летит, а не после удара.
 */
export type FallTrack = {
  /** Поза на каждом шаге подряд: x y z qx qy qz qw. */
  poses: Float32Array
  steps: number
  step: number
  /** Точка скана, которой находка коснулась пола (координаты экспоната). */
  contact: [number, number, number]
  /** Та же точка в мире — туда ставим волну удара. */
  contactWorld: [number, number, number]
}

export class CarryPhysics {
  /** Опорная точка — примерно там, где находку держат руками. */
  readonly pos = new THREE.Vector3()
  readonly vel = new THREE.Vector3()
  /** Наклон: x — вокруг оси X, y — вокруг оси Z. */
  readonly swing = new THREE.Vector2()
  readonly swingVel = new THREE.Vector2()
  stability = 1
  falling = false

  constructor(start: THREE.Vector3) {
    this.pos.copy(start)
  }

  /**
   * @param aim куда тянет курсор; null — находку отпустили и она садится на стол
   * @param groundY высота опорной точки, когда находка стоит
   */
  step(dt: number, aim: THREE.Vector3 | null, groundY: number) {
    if (this.falling) {
      this.vel.y -= GRAVITY * dt
      this.pos.addScaledVector(this.vel, dt)
      this.swing.addScaledVector(this.swingVel, dt)
      return
    }

    if (aim) {
      acc.copy(aim).sub(this.pos).multiplyScalar(FOLLOW_K).addScaledVector(this.vel, -FOLLOW_C)
    } else {
      // отпустили: находка опускается туда, где стоит, и успокаивается
      acc.set(0, (groundY - this.pos.y) * FOLLOW_K, 0).addScaledVector(this.vel, -FOLLOW_C)
    }
    this.vel.addScaledVector(acc, dt)
    this.pos.addScaledVector(this.vel, dt)

    // маятник: горизонтальное ускорение опоры кладёт находку набок
    const ax = -SWING_K * this.swing.x - SWING_C * this.swingVel.x + SWING_GAIN * acc.z
    const az = -SWING_K * this.swing.y - SWING_C * this.swingVel.y - SWING_GAIN * acc.x
    this.swingVel.x += ax * dt
    this.swingVel.y += az * dt
    this.swing.x = THREE.MathUtils.clamp(this.swing.x + this.swingVel.x * dt, -SWING_MAX, SWING_MAX)
    this.swing.y = THREE.MathUtils.clamp(this.swing.y + this.swingVel.y * dt, -SWING_MAX, SWING_MAX)

    // Наклон — основной расход. Плюс штраф за голую скорость: иначе нашёлся бы
    // обход — трясти так часто, что маятник не успевает раскачаться.
    const rush = Math.max(0, this.vel.length() - SAFE_SPEED) * SPEED_W
    const over = Math.max(0, this.tilt - TILT_SAFE) + rush
    if (over > 0) this.stability = Math.max(0, this.stability - over * DRAIN * dt)
    else this.stability = Math.min(1, this.stability + (aim ? REGAIN_HELD : REGAIN_DOWN) * dt)

    // Сорвалось: дальше только гравитация. Находка выскальзывает из рук, а не
    // летит снарядом — иначе после рывка она улетала бы за край стола.
    if (this.stability <= 0 && aim) {
      this.falling = true
      this.vel.x *= 0.3
      this.vel.z *= 0.3
      this.vel.y = Math.min(this.vel.y, 0)
      this.swingVel.clampScalar(-2.5, 2.5)
    }
  }

  /** Наклон в радианах — им же красится шкала устойчивости. */
  get tilt() {
    return Math.hypot(this.swing.x, this.swing.y)
  }

  quaternion(out: THREE.Quaternion) {
    euler.set(this.swing.x, 0, this.swing.y)
    return out.setFromEuler(euler)
  }

  /**
   * Прогоняет падение до касания пола, не трогая собственное состояние.
   * @param probe точки уцелевших черепков (x y z подряд, координаты экспоната)
   * @param pivotY высота опорной точки над основанием экспоната
   */
  simulateFall(probe: Float32Array, pivotY: number): FallTrack {
    const pos = this.pos.clone()
    const vel = this.vel.clone()
    const swing = this.swing.clone()
    const poses = new Float32Array((FALL_MAX_STEPS + 1) * 7)
    const contact: [number, number, number] = [0, 0, 0]
    const contactWorld: [number, number, number] = [pos.x, 0, pos.z]

    let steps = 0
    for (let s = 0; s <= FALL_MAX_STEPS; s++) {
      if (s > 0) {
        vel.y -= GRAVITY * FALL_STEP
        pos.addScaledVector(vel, FALL_STEP)
        swing.addScaledVector(this.swingVel, FALL_STEP)
      }
      euler.set(swing.x, 0, swing.y)
      fallQuat.setFromEuler(euler)
      const m = fallMatrix.makeRotationFromQuaternion(fallQuat).elements

      // какой точкой находка сейчас ниже всего
      let lowest = Infinity
      let at = 0
      for (let i = 0; i < probe.length; i += 3) {
        const y = m[1] * probe[i] + m[5] * (probe[i + 1] - pivotY) + m[9] * probe[i + 2]
        if (y < lowest) {
          lowest = y
          at = i
        }
      }

      const touched = pos.y + lowest <= 0 || s === FALL_MAX_STEPS
      if (touched) {
        pos.y = -lowest // ставим находку низшей точкой ровно на пол
        const px = probe[at]
        const py = probe[at + 1] - pivotY
        const pz = probe[at + 2]
        contact[0] = probe[at]
        contact[1] = probe[at + 1]
        contact[2] = probe[at + 2]
        contactWorld[0] = pos.x + m[0] * px + m[4] * py + m[8] * pz
        contactWorld[2] = pos.z + m[2] * px + m[6] * py + m[10] * pz
      }

      const o = s * 7
      poses[o] = pos.x
      poses[o + 1] = pos.y
      poses[o + 2] = pos.z
      poses[o + 3] = fallQuat.x
      poses[o + 4] = fallQuat.y
      poses[o + 5] = fallQuat.z
      poses[o + 6] = fallQuat.w
      steps = s + 1
      if (touched) break
    }

    return { poses: poses.slice(0, steps * 7), steps, step: FALL_STEP, contact, contactWorld }
  }
}
