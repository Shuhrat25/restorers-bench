/**
 * Звук удара — синтез, а не запись.
 *
 * Керамика звучит узнаваемо из трёх слоёв: глухой удар телом о пол, короткий
 * треск излома и звон черепков — набор негармонических призвуков, которые быстро
 * гаснут. Потом осколки разъезжаются по столу мелким перезвоном. Всё это собирается
 * из шума и синусов, поэтому не нужно ни файлов, ни лицензий на звук, и каждый
 * удар звучит немного по-своему.
 *
 * Графы строятся на BaseAudioContext, чтобы их можно было отрендерить офлайн
 * и проверить уровни, не слушая.
 */

const MASTER = 0.85

let ctx: AudioContext | null = null
let master: GainNode | null = null
let muted = false

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>()

/** Браузер разрешает звук только после жеста: зовём на первом нажатии. */
export function unlockAudio() {
  if (typeof AudioContext === 'undefined') return
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = muted ? 0 : MASTER
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
}

export function setMuted(value: boolean) {
  muted = value
  if (master) master.gain.value = value ? 0 : MASTER
}

/**
 * @param strength 0..1 — насколько сильным был удар
 * @param pan -1..1 — где на экране он случился
 */
export function playImpact(strength = 1, pan = 0) {
  if (!ctx || !master || muted) return
  buildImpact(ctx, master, ctx.currentTime + 0.01, strength, pan, Math.random)
}

/** Перезвон черепков, разъезжающихся по столу. */
export function playScatter(count: number, pan = 0) {
  if (!ctx || !master || muted) return
  buildScatter(ctx, master, ctx.currentTime + 0.05, count, pan, Math.random)
}

export function buildImpact(
  ac: BaseAudioContext,
  out: AudioNode,
  t: number,
  strength: number,
  pan: number,
  rnd: () => number,
) {
  const bus = busTo(ac, out, pan)
  const k = 0.55 + 0.45 * clamp01(strength)

  // 1. Глухой удар: низкий тон с падающей высотой плюс низкочастотный шум
  const body = ac.createOscillator()
  body.type = 'sine'
  body.frequency.setValueAtTime(130, t)
  body.frequency.exponentialRampToValueAtTime(48, t + 0.14)
  const bodyGain = envelope(ac, t, 0.003, 0.22, 0.5 * k)
  body.connect(bodyGain).connect(bus)
  body.start(t)
  body.stop(t + 0.3)

  const thud = noise(ac)
  const thudFilter = ac.createBiquadFilter()
  thudFilter.type = 'lowpass'
  thudFilter.frequency.value = 900
  thud.connect(thudFilter).connect(envelope(ac, t, 0.002, 0.16, 0.38 * k)).connect(bus)
  thud.start(t)
  thud.stop(t + 0.25)

  // 2. Излом: несколько коротких трещин подряд — ваза лопается не в одном месте
  const cracks = 3 + Math.floor(rnd() * 3)
  for (let i = 0; i < cracks; i++) {
    const at = t + (i === 0 ? 0 : 0.012 + rnd() * 0.11)
    const amp = (i === 0 ? 0.48 : 0.16 + rnd() * 0.18) * k
    const crack = noise(ac)
    const band = ac.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = 2400 + rnd() * 2600
    band.Q.value = 0.8
    crack.connect(band).connect(envelope(ac, at, 0.001, 0.035 + rnd() * 0.04, amp)).connect(bus)
    crack.start(at, rnd() * 0.5)
    crack.stop(at + 0.12)

    // 3. Звон керамики: негармонические призвуки, верхние гаснут быстрее
    ring(ac, bus, at, 1500 + rnd() * 1300, (i === 0 ? 0.19 : 0.09) * k, rnd)
  }
}

export function buildScatter(
  ac: BaseAudioContext,
  out: AudioNode,
  t: number,
  count: number,
  pan: number,
  rnd: () => number,
) {
  const bus = busTo(ac, out, pan)
  const clinks = Math.min(12, Math.max(4, count))
  for (let i = 0; i < clinks; i++) {
    // черепки ложатся гуще в начале разлёта, реже в конце
    const at = t + 0.25 + Math.pow(rnd(), 1.6) * 0.85
    const amp = 0.025 + rnd() * 0.045
    const tick = noise(ac)
    const high = ac.createBiquadFilter()
    high.type = 'highpass'
    high.frequency.value = 3500
    tick.connect(high).connect(envelope(ac, at, 0.001, 0.012, amp)).connect(bus)
    tick.start(at, rnd() * 0.5)
    tick.stop(at + 0.05)
    ring(ac, bus, at, 2600 + rnd() * 3200, amp * 0.8, rnd, 3)
  }
}

/** Негармонический набор призвуков — то, что отличает керамику от металла и дерева. */
function ring(ac: BaseAudioContext, out: AudioNode, t: number, f0: number, amp: number, rnd: () => number, partials = 5) {
  const ratios = [1, 1.59, 2.32, 3.08, 4.23]
  for (let p = 0; p < partials; p++) {
    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = f0 * ratios[p] * (0.97 + rnd() * 0.06)
    const decay = 0.32 / Math.sqrt(p + 1) * (0.7 + rnd() * 0.6)
    const start = t + rnd() * 0.006
    osc.connect(envelope(ac, start, 0.001, decay, amp / Math.pow(p + 1, 0.7))).connect(out)
    osc.start(start)
    osc.stop(start + decay * 4 + 0.05)
  }
}

/** Мгновенная атака и экспоненциальный спад: так звучит всё, по чему ударили. */
function envelope(ac: BaseAudioContext, t: number, attack: number, decay: number, peak: number) {
  const g = ac.createGain()
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(peak, t + attack)
  // постоянная времени decay/3: к моменту t+decay остаётся ~5%
  g.gain.setTargetAtTime(0, t + attack, decay / 3)
  return g
}

/** Общая шина удара: панорама по месту на экране и лимитер, чтобы слои не клиповали. */
function busTo(ac: BaseAudioContext, out: AudioNode, pan: number) {
  const limiter = ac.createDynamicsCompressor()
  limiter.threshold.value = -8
  limiter.knee.value = 4
  limiter.ratio.value = 12
  limiter.attack.value = 0.002
  limiter.release.value = 0.2
  const panner = ac.createStereoPanner()
  panner.pan.value = Math.max(-0.8, Math.min(0.8, pan))
  limiter.connect(panner).connect(out)
  return limiter
}

function noise(ac: BaseAudioContext) {
  let buffer = noiseBuffers.get(ac)
  if (!buffer) {
    buffer = ac.createBuffer(1, ac.sampleRate, ac.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    noiseBuffers.set(ac, buffer)
  }
  const src = ac.createBufferSource()
  src.buffer = buffer
  return src
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v))
}
