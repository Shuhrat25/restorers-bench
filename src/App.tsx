import { useCallback, useEffect, useMemo, useState } from 'react'
import { Scene } from './components/Scene'
import type { Progress } from './components/Artifact'
import { ARTIFACTS, DEFAULT_SETTINGS, type Phase, type Settings } from './artifact'
import './App.css'

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [hintLevel, setHintLevel] = useState(0)
  const [hintsUsed, setHintsUsed] = useState(0)
  const [wrong, setWrong] = useState(0)
  const [revealAll, setRevealAll] = useState(0)
  const [progress, setProgress] = useState<Progress>({ total: 0, placed: 0, lost: 0, done: false })
  const [finaleSeen, setFinaleSeen] = useState(false)
  const [phase, setPhase] = useState<Phase>('carry')
  const [stability, setStability] = useState(1)
  // уронил ли посетитель находку по дороге — от этого зависит и текст, и сложность
  const [dropped, setDropped] = useState(false)
  // счётчик ударов: ключ вспышки, чтобы CSS-анимация проигрывалась на каждом ударе
  const [impacts, setImpacts] = useState(0)
  const [backside, setBackside] = useState(false)

  const patch = useCallback((p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })), [])
  const def = useMemo(
    () => ARTIFACTS.find((a) => a.id === settings.artifactId) ?? ARTIFACTS[0],
    [settings.artifactId],
  )

  // Подсказка действует на выбранный черепок; сменил черепок — начинай заново.
  useEffect(() => setHintLevel(0), [selectedId])

  const onProgress = useCallback((p: Progress) => setProgress(p), [])
  const onWrong = useCallback(() => setWrong((w) => w + 1), [])
  const onStability = useCallback((v: number) => setStability(v), [])
  const onImpact = useCallback(() => setImpacts((n) => n + 1), [])
  const onBackside = useCallback((hidden: boolean) => setBackside(hidden), [])
  const onPhase = useCallback((p: Phase) => {
    setPhase((prev) => (prev === p ? prev : p))
    if (p === 'falling') setDropped(true)
  }, [])

  const restart = useCallback(() => {
    setHintsUsed(0)
    setWrong(0)
    setHintLevel(0)
    setSelectedId(null)
    setFinaleSeen(false)
    setRevealAll(0)
    setPhase('carry')
    setDropped(false)
    // пересоздаём сцену сменой ключа артефакта
    setSettings((s) => ({ ...s }))
    window.location.reload()
  }, [])

  useEffect(() => {
    if (progress.done) setFinaleSeen(true)
  }, [progress.done])

  const useHint = () => {
    if (selectedId === null || hintLevel >= 2) return
    setHintLevel((h) => h + 1)
    setHintsUsed((h) => h + 1)
  }

  const carrying = phase === 'carry' || phase === 'falling'
  const risk = carrying ? Math.max(0, 1 - stability / 0.45) : 0

  return (
    <div className="app">
      <Scene
        settings={settings}
        hintLevel={hintLevel}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onProgress={onProgress}
        onWrong={onWrong}
        revealAll={revealAll}
        phase={phase}
        onPhase={onPhase}
        onStability={onStability}
        onImpact={onImpact}
        onBackside={onBackside}
      />

      {/* край кадра краснеет, когда находка вот-вот сорвётся */}
      <div className="risk" style={{ opacity: risk }} />
      {impacts > 0 && <div key={impacts} className="flash" />}

      <header className="label">
        <div className="label-title">{def.title}</div>
        <div className="label-epoch">{def.epoch}</div>
        <div className="label-museum">{def.museum}</div>
      </header>

      <section className="task">
        <div className="task-head">{carrying ? 'Ящик с раскопа' : 'Верстак реставратора'}</div>
        <p className="task-text">
          {phase === 'carry'
            ? 'Возьмите находку из ящика и перенесите её на подставку. Ведите плавно: от рывков она раскачивается, а сорвётся — расколется ещё сильнее.'
            : phase === 'falling'
              ? 'Сорвалась.'
              : progress.done
                ? 'Экспонат собран. Голограммой показано то, что не сохранилось.'
                : backside
                  ? 'Это место на обратной стороне. Поверните экспонат, чтобы его было видно.'
                  : selectedId === null
                  ? dropped
                    ? 'Новые сколы пошли от точки удара — черепков стало больше. Берите любой и тяните на место.'
                    : 'Донесли целой. Снимаем полевую склейку — и собираем заново, уже по-настоящему.'
                  : 'Подведите черепок к его месту — он защёлкнется сам. Или просто кликните по гнезду.'}
        </p>

        {carrying ? (
          <>
            <div className="bar">
              <span
                className={stability < 0.45 ? 'danger' : undefined}
                style={{ width: `${Math.max(0, stability) * 100}%` }}
              />
            </div>
            <div className="stats">
              <span>Устойчивость</span>
              <span>
                <b>{Math.round(Math.max(0, stability) * 100)}</b>%
              </span>
            </div>
            <p className="note">
              Отпустите кнопку мыши — находка встанет на стол и отдышится. Спешить некуда.
            </p>
          </>
        ) : (
          <>
            <div className="bar">
              <span style={{ width: `${progress.total ? (progress.placed / progress.total) * 100 : 0}%` }} />
            </div>
            <div className="stats">
              <span>
                Установлено <b>{progress.placed}</b> из <b>{progress.total}</b>
              </span>
              <span>
                Утрачено <b>{progress.lost}</b>
              </span>
            </div>

            <div className="row">
              <button className="btn" onClick={useHint} disabled={selectedId === null || hintLevel >= 2}>
                {hintLevel === 0 ? 'Подсказка' : hintLevel === 1 ? 'Точнее' : 'Показано'}
              </button>
              <span className="counter">использовано: {hintsUsed}</span>
              {wrong > 0 && <span className="counter err">ошибок: {wrong}</span>}
            </div>
          </>
        )}

        <div className="row">
          {!carrying && (
            <button className="btn ghost" onClick={() => setRevealAll((n) => n + 1)} disabled={progress.done}>
              Показать результат
            </button>
          )}
          <button className="btn ghost" onClick={restart}>
            Заново
          </button>
        </div>
      </section>

      <aside className="panel">
        {ARTIFACTS.length > 1 && <div className="panel-head">Экспонат</div>}
        {ARTIFACTS.length > 1 &&
          ARTIFACTS.map((a) => (
            <button
              key={a.id}
              className={a.id === settings.artifactId ? 'item active' : 'item'}
              onClick={() => patch({ artifactId: a.id })}
            >
              {a.title}
            </button>
          ))}

        <div className="panel-head">Вид</div>
        <label className="check">
          <input
            autoComplete="off"
            type="checkbox"
            checked={settings.showReconstruction}
            onChange={(e) => patch({ showReconstruction: e.target.checked })}
          />
          <span>Реконструкция утраченного</span>
        </label>
        <label className="check">
          <input
            autoComplete="off"
            type="checkbox"
            checked={settings.xray}
            onChange={(e) => patch({ xray: e.target.checked })}
          />
          <span>Рентген</span>
        </label>
        <label className="check">
          <input
            autoComplete="off"
            type="checkbox"
            checked={settings.autoRotate}
            onChange={(e) => patch({ autoRotate: e.target.checked })}
          />
          <span>Автовращение</span>
        </label>
        <label className="check">
          <input
            autoComplete="off"
            type="checkbox"
            checked={settings.sound}
            onChange={(e) => patch({ sound: e.target.checked })}
          />
          <span>Звук</span>
        </label>

        <p className="note">
          Снимите «Реконструкцию» — и останется только то, что действительно дошло до нас.
        </p>
      </aside>

      {finaleSeen && progress.done && (
        <div className="finale" onClick={() => setFinaleSeen(false)}>
          <div className="finale-box">
            <div className="finale-title">Экспонат собран</div>
            <p>
              Подлинных черепков: <b>{progress.placed}</b>. Утрачено и восстановлено проекцией:{' '}
              <b>{progress.lost}</b>.
            </p>
            <p className="finale-sub">
              {dropped ? 'Находку уронили по дороге' : 'Донесена без потерь'} · подсказок: {hintsUsed} · ошибок:{' '}
              {wrong}
            </p>
            <button className="btn" onClick={() => setFinaleSeen(false)}>
              Рассмотреть
            </button>
          </div>
        </div>
      )}

      <footer className="credits">
        «{def.title}» — {def.author} ({def.museum}), {def.license}
      </footer>
    </div>
  )
}
