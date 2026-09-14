import { fractureArrays, type FractureSource, type FragmentData, type ImpactData } from './fractureCore'
import { toFragments, type Fragment } from './fracture'
import type { FractureRequest } from './fracture.worker'

export type FractureClient = {
  fracture: (count: number, seed: number, impact: ImpactData | null) => Promise<Fragment[]>
  dispose: () => void
}

/**
 * Раскол в фоне. Если воркер поднять не удалось (старый браузер, страница открыта
 * с диска), считаем в основном потоке — с паузой, но игра не ломается.
 */
export function createFractureClient(source: FractureSource): FractureClient {
  let worker: Worker | null = null
  try {
    worker = new Worker(new URL('./fracture.worker.ts', import.meta.url), { type: 'module' })
    // копия: основному потоку массивы скана ещё нужны
    worker.postMessage({ type: 'source', source } satisfies FractureRequest)
  } catch {
    worker = null
  }

  let nextId = 0
  const pending = new Map<number, (data: FragmentData[]) => void>()
  if (worker) {
    worker.onmessage = (e: MessageEvent<{ id: number; fragments: FragmentData[] }>) => {
      pending.get(e.data.id)?.(e.data.fragments)
      pending.delete(e.data.id)
    }
  }

  return {
    fracture(count, seed, impact) {
      if (!worker) {
        return new Promise((resolve) =>
          setTimeout(() => resolve(toFragments(fractureArrays(source, count, seed, impact))), 0),
        )
      }
      const id = nextId++
      return new Promise((resolve) => {
        pending.set(id, (data) => resolve(toFragments(data)))
        worker.postMessage({ type: 'fracture', id, count, seed, impact } satisfies FractureRequest)
      })
    },
    dispose() {
      pending.clear()
      worker?.terminate()
    },
  }
}
