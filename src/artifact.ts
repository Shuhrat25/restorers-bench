export type ArtifactDef = {
  id: string
  /** Название экспоната. */
  title: string
  /** Период и происхождение — то, что музей пишет на этикетке. */
  epoch: string
  museum: string
  author: string
  license: string
  file: string
  /** На сколько черепков колем. */
  pieces: number
  /** Доля черепков, которые «не нашли» — они останутся голограммой. */
  lostShare: number
  /** Сколько черепков добавится, если находку уронить. */
  brokenExtra: number
}

export const ARTIFACTS: ArtifactDef[] = [
  {
    id: 'krater',
    title: 'Чернофигурный кратер',
    epoch: 'Древняя Греция, VI в. до н. э.',
    museum: 'Одесский археологический музей',
    author: 'OdesaArchaeologicalMuseum',
    license: 'CC BY 4.0',
    file: 'krater.glb',
    pieces: 14,
    lostShare: 0.35,
    brokenExtra: 8,
  },

]

/**
 * Раскладка мастерской. Держим её здесь, а не в компонентах: ящик рисует
 * Workshop, а стартовую позицию находки считает Artifact — им нужно одно число.
 */
export function crateSpot(radius: number): [number, number, number] {
  const r = Math.max(radius * 3, 5.2)
  return [-r * 0.88, 0, r * 0.52]
}

export const crateSize = (radius: number, height: number) => ({
  w: Math.max(radius * 2.7, 2.6),
  d: Math.max(radius * 2.7, 2.6),
  h: height * 0.3,
})

export const pedestalRadius = (radius: number) => Math.max(radius * 1.3, 1.6)

export const artifactUrl = (a: ArtifactDef) => `${import.meta.env.BASE_URL}models/${a.file}`

export type Settings = {
  artifactId: string
  /** Показывать ли голограммную реконструкцию утраченного. */
  showReconstruction: boolean
  /** Рентген: собранные черепки тоже показываются голограммой. */
  xray: boolean
  autoRotate: boolean
  /** Звук удара. На киоске в тихом зале его захотят выключить. */
  sound: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  artifactId: ARTIFACTS[0].id,
  showReconstruction: true,
  xray: false,
  autoRotate: false,
  sound: true,
}

/**
 * Фазы раунда: несём экспонат из ящика на подставку, при срыве собираем заново.
 * 'done' — донёс целым либо собрал заново.
 */
export type Phase = 'carry' | 'falling' | 'repair' | 'done'

/** Состояние черепка в ходе реставрации. */
export type PieceState = 'loose' | 'placed' | 'lost'
