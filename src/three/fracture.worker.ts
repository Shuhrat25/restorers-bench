import { fractureArrays, type FractureSource, type ImpactData } from './fractureCore'

export type FractureRequest =
  | { type: 'source'; source: FractureSource }
  | { type: 'fracture'; id: number; count: number; seed: number; impact: ImpactData | null }

// Скан приходит один раз при загрузке: гонять 10+ МБ на каждый удар незачем.
let source: FractureSource | null = null

self.onmessage = (e: MessageEvent<FractureRequest>) => {
  const msg = e.data
  if (msg.type === 'source') {
    source = msg.source
    // Прогрев: первый проход в свежем воркере заметно медленнее — JIT ещё не разогнан.
    // Настоящий раскол нужен к моменту удара, а падение длится полсекунды, так что
    // холодный старт тратим сейчас, пока посетитель только несёт находку.
    fractureArrays(source, 6, 1, null)
    return
  }
  if (!source) return
  const fragments = fractureArrays(source, msg.count, msg.seed, msg.impact)
  // буферы черепков отдаём, а не копируем
  const transfer: ArrayBuffer[] = []
  for (const f of fragments) {
    transfer.push(f.position.buffer as ArrayBuffer, f.index.buffer as ArrayBuffer)
    if (f.normal) transfer.push(f.normal.buffer as ArrayBuffer)
    if (f.uv) transfer.push(f.uv.buffer as ArrayBuffer)
  }
  postMessage({ id: msg.id, fragments }, { transfer })
}
