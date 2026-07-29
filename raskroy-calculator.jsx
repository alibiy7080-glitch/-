import React, { useState, useCallback, useEffect } from "react";
import { Plus, Trash2, Ruler, Hammer, History, RotateCcw, X } from "lucide-react";

const TYPE_LABELS = {
  L: "Рама",
  T: "Импост",
  Z: "Створка",
};

const TYPE_FILLS = {
  L: { bg: "#DCEFFB", border: "#7FB8DC", text: "#173247" },
  T: { bg: "#E6E0F8", border: "#A995DD", text: "#2A2145" },
  Z: { bg: "#DFF5E1", border: "#7FCB8E", text: "#1B3A22" },
};

let uid = 100;
const nextId = () => uid++;

// 0/1 knapsack: choose a subset of pseudoItems (each {weight, ...}) maximizing total
// weight without exceeding capacity. Returns the indices chosen.
function knapsack01(pseudoItems, capacity) {
  const n = pseudoItems.length;
  const dp = new Int32Array(capacity + 1);
  const take = new Uint8Array(n * (capacity + 1));

  for (let i = 0; i < n; i++) {
    const w = pseudoItems[i].weight;
    if (w > capacity || w <= 0) continue;
    for (let j = capacity; j >= w; j--) {
      const candidate = dp[j - w] + w;
      if (candidate > dp[j]) {
        dp[j] = candidate;
        take[i * (capacity + 1) + j] = 1;
      }
    }
  }

  const chosen = [];
  let j = capacity;
  for (let i = n - 1; i >= 0; i--) {
    if (take[i * (capacity + 1) + j] === 1) {
      chosen.push(i);
      j -= pseudoItems[i].weight;
    }
  }
  return { totalWeight: dp[capacity], chosenIndices: chosen };
}

// Finds the fullest possible single bin from the available lengths (each with a
// limited count), using bounded knapsack via binary-split pseudo-items so large
// quantities don't blow up the DP. Returns a Map(length -> countUsed).
function bestBinFill(lengthCounts, capacity, kerf) {
  const pseudoItems = [];
  lengthCounts.forEach(({ length, count }) => {
    const unitWeight = length + kerf;
    let remaining = count;
    let chunk = 1;
    while (remaining > 0) {
      const take = Math.min(chunk, remaining);
      pseudoItems.push({ length, count: take, weight: unitWeight * take });
      remaining -= take;
      chunk *= 2;
    }
  });

  const { chosenIndices } = knapsack01(pseudoItems, capacity);
  const perLength = new Map();
  chosenIndices.forEach((i) => {
    const { length, count } = pseudoItems[i];
    perLength.set(length, (perLength.get(length) || 0) + count);
  });
  return perLength;
}

// Repeatedly fills one bin at a time as fully as possible from whatever lengths are
// still available — so 1400+1400+1200+1200 gets combined into one bin when that's
// the tightest fit, instead of grouping same-length pieces first.
function packItemsDP(items, capacity, kerf) {
  const queues = new Map(); // length -> array of item objects (FIFO)
  items.forEach((item) => {
    const len = Math.round(item.length);
    if (!queues.has(len)) queues.set(len, []);
    queues.get(len).push(item);
  });

  const bins = [];
  let totalRemaining = items.length;

  while (totalRemaining > 0) {
    const lengthCounts = [];
    queues.forEach((q, len) => {
      if (q.length > 0) lengthCounts.push({ length: len, count: q.length });
    });

    const perLength = bestBinFill(lengthCounts, capacity, kerf);

    let placedThisBin = 0;
    const cuts = [];
    perLength.forEach((count, len) => {
      const q = queues.get(len);
      for (let k = 0; k < count; k++) {
        cuts.push(q.shift());
        placedThisBin++;
      }
    });

    if (placedThisBin === 0) {
      // Nothing left fits (kerf pushed a piece just over capacity) — stop to avoid
      // an infinite loop; caller surfaces the remaining count as an error.
      break;
    }

    const used = cuts.reduce((s, c) => s + c.length + kerf, 0);
    bins.push({ remaining: capacity - used, cuts });
    totalRemaining -= placedThisBin;
  }

  return { bins, unplaced: totalRemaining };
}

// After the initial Best-Fit-Decreasing pass, try to eliminate bars entirely by
// redistributing a bar's cuts into the others. Order of pieces doesn't matter —
// this only cares about using as few stock bars (and as little waste) as possible.
function reduceBinCount(initialBars, kerf) {
  let bars = initialBars.map((b) => ({ remaining: b.remaining, cuts: [...b.cuts] }));
  let improved = true;

  while (improved) {
    improved = false;
    const order = bars.map((_, i) => i).sort((a, b) => bars[b].remaining - bars[a].remaining);

    for (const idx of order) {
      const candidate = bars[idx];
      const others = bars.filter((_, i) => i !== idx);
      const trial = others.map((b) => ({ remaining: b.remaining, cuts: [...b.cuts] }));
      const sortedCuts = [...candidate.cuts].sort((a, b) => b.length - a.length);

      let success = true;
      for (const cut of sortedCuts) {
        const need = cut.length + kerf;
        let bestIdx = -1;
        let bestRemainder = Infinity;
        trial.forEach((b, i2) => {
          if (b.remaining >= need && b.remaining - need < bestRemainder) {
            bestRemainder = b.remaining - need;
            bestIdx = i2;
          }
        });
        if (bestIdx === -1) {
          success = false;
          break;
        }
        trial[bestIdx].remaining -= need;
        trial[bestIdx].cuts.push(cut);
      }

      if (success) {
        bars = trial;
        improved = true;
        break; // bars changed — recompute the removal order from scratch
      }
    }
  }

  return bars;
}

export default function RaskroyCalculator() {
  const [stockLength, setStockLength] = useState(6000);
  const [kerf, setKerf] = useState(5);
  const [pieces, setPieces] = useState([
    { id: nextId(), type: "L", label: "Рама верх/низ", length: 1180, qty: 12 },
    { id: nextId(), type: "L", label: "Рама стойка", length: 1420, qty: 12 },
    { id: nextId(), type: "T", label: "Импост", length: 1160, qty: 6 },
    { id: nextId(), type: "Z", label: "Створка", length: 1150, qty: 6 },
  ]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const loadHistory = useCallback(async () => {
    try {
      const listed = await window.storage.list("history:", false);
      const keys = listed?.keys || [];
      const entries = [];
      for (const key of keys) {
        try {
          const rec = await window.storage.get(key, false);
          if (rec?.value) entries.push(JSON.parse(rec.value));
        } catch (e) {
          // skip unreadable entry
        }
      }
      entries.sort((a, b) => b.ts - a.ts);
      setHistory(entries);
    } catch (e) {
      // storage unavailable — history simply stays empty
    } finally {
      setHistoryLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const saveHistoryEntry = async (entry) => {
    try {
      await window.storage.set(`history:${entry.ts}`, JSON.stringify(entry), false);
      setHistory((h) => [entry, ...h].slice(0, 30));
    } catch (e) {
      // saving is best-effort — calculation itself still works without it
    }
  };

  const deleteHistoryEntry = async (ts) => {
    try {
      await window.storage.delete(`history:${ts}`, false);
    } catch (e) {
      // ignore
    }
    setHistory((h) => h.filter((item) => item.ts !== ts));
  };

  const restoreHistoryEntry = (entry) => {
    setStockLength(entry.stockLength);
    setKerf(entry.kerf);
    setPieces(entry.pieces.map((p) => ({ ...p, id: nextId() })));
    setResult(entry.result);
    setError("");
  };

  const updatePiece = (id, field, value) => {
    setPieces((p) => p.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  };

  const addPiece = () => {
    setPieces((p) => [...p, { id: nextId(), type: "L", label: "", length: 1000, qty: 1 }]);
  };

  const removePiece = (id) => {
    setPieces((p) => p.filter((row) => row.id !== id));
  };

  const calculate = useCallback(() => {
    setError("");
    const L = Number(stockLength);
    const K = Number(kerf);

    if (!L || L <= 0) {
      setError("Укажите длину хлыста профиля.");
      setResult(null);
      return;
    }

    const oversize = pieces.find((p) => Number(p.length) > L);
    if (oversize) {
      setError(`Деталь "${oversize.label || oversize.length + " мм"}" длиннее хлыста (${oversize.length} мм > ${L} мм).`);
      setResult(null);
      return;
    }

    // Expand pieces into individual items, tag with the source row for color/label
    let items = [];
    pieces.forEach((row, rowIdx) => {
      const qty = Math.max(0, Number(row.qty) || 0);
      for (let i = 0; i < qty; i++) {
        items.push({ length: Number(row.length), label: row.label || `${row.length} мм`, type: row.type || "L", rowIdx });
      }
    });

    if (items.length === 0) {
      setError("Добавьте хотя бы одну деталь с количеством > 0.");
      setResult(null);
      return;
    }

    // L, T and Z are physically different profiles (different cross-section) — each
    // must be cut from its own stock bars. Pack every type independently.
    const typeTotals = { L: { qty: 0, length: 0, bars: 0 }, T: { qty: 0, length: 0, bars: 0 }, Z: { qty: 0, length: 0, bars: 0 } };
    let bars = [];
    let unplacedCount = 0;

    ["L", "T", "Z"].forEach((t) => {
      const group = items.filter((it) => it.type === t);
      if (group.length === 0) return;

      group.forEach((item) => {
        typeTotals[t].qty += 1;
        typeTotals[t].length += item.length;
      });

      const { bins: initialBars, unplaced } = packItemsDP(group, L, K);
      unplacedCount += unplaced;

      const typeBars = reduceBinCount(initialBars, K).map((b, i) => ({ ...b, type: t, barIndex: i + 1 }));
      typeTotals[t].bars = typeBars.length;
      bars = bars.concat(typeBars);
    });

    if (unplacedCount > 0) {
      setError(`Не удалось разместить ${unplacedCount} дет. — с учётом пропила они не влезают в хлыст. Проверьте длину хлыста/пропил.`);
      setResult(null);
      return;
    }

    const totalStock = bars.length * L;
    const totalWaste = bars.reduce((s, b) => s + Math.max(0, b.remaining), 0);
    const wastePercent = (totalWaste / totalStock) * 100;

    const resultObj = {
      bars,
      stockLength: L,
      kerf: K,
      totalBars: bars.length,
      totalWaste,
      wastePercent,
      totalPieces: items.length,
      typeTotals,
    };

    setResult(resultObj);

    saveHistoryEntry({
      ts: Date.now(),
      stockLength: L,
      kerf: K,
      pieces: pieces.map(({ type, label, length, qty }) => ({ type, label, length, qty })),
      result: resultObj,
    });
  }, [stockLength, kerf, pieces]);

  return (
    <div
      style={{
        background: "#101825",
        minHeight: "100%",
        color: "#E7EEF4",
        fontFamily: "'Barlow Condensed', 'Inter', sans-serif",
      }}
      className="p-4 sm:p-8"
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
        .mono { font-family: 'JetBrains Mono', monospace; }
        input[type=number]::-webkit-inner-spin-button { opacity: 1; }
      `}</style>

      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-1">
          <Ruler size={28} color="#FF8A3D" />
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-wide" style={{ letterSpacing: "0.02em" }}>
            РАСКРОЙ ПРОФИЛЯ — ЭКОНОМ-ЛИНЕЙКА
          </h1>
        </div>
        <p className="text-sm mb-6" style={{ color: "#8FA3B8" }}>
          Оптимальная раскладка деталей по хлыстам профиля. Каждый хлыст заполняется максимально плотно (разные длины комбинируются).
        </p>

        {/* Settings */}
        <div
          className="rounded-lg p-4 sm:p-5 mb-5 grid grid-cols-2 sm:grid-cols-4 gap-4"
          style={{ background: "#16202E", border: "1px solid #223047" }}
        >
          <div>
            <label className="block text-xs mb-1" style={{ color: "#8FA3B8" }}>
              Длина хлыста, мм
            </label>
            <input
              type="number"
              value={stockLength}
              onChange={(e) => setStockLength(e.target.value)}
              className="mono w-full rounded px-2 py-1.5 text-lg"
              style={{ background: "#0B121C", border: "1px solid #2C3B52", color: "#E7EEF4" }}
            />
          </div>
          <div>
            <label className="block text-xs mb-1" style={{ color: "#8FA3B8" }}>
              Пропил (кермф), мм
            </label>
            <input
              type="number"
              value={kerf}
              onChange={(e) => setKerf(e.target.value)}
              className="mono w-full rounded px-2 py-1.5 text-lg"
              style={{ background: "#0B121C", border: "1px solid #2C3B52", color: "#E7EEF4" }}
            />
          </div>
          <div className="col-span-2 flex items-end">
            <button
              onClick={calculate}
              className="w-full rounded font-semibold py-2 flex items-center justify-center gap-2 transition-transform active:scale-[0.98]"
              style={{ background: "#FF8A3D", color: "#1B120A" }}
            >
              <Hammer size={18} />
              РАССЧИТАТЬ РАСКРОЙ
            </button>
          </div>
        </div>

        {/* Pieces table */}
        <div className="rounded-lg p-4 sm:p-5 mb-5" style={{ background: "#16202E", border: "1px solid #223047" }}>
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-xl font-semibold" style={{ letterSpacing: "0.02em" }}>
              ДЕТАЛИ
            </h2>
            <button
              onClick={addPiece}
              className="flex items-center gap-1 text-sm rounded px-3 py-1.5"
              style={{ background: "#1E2C3E", color: "#8FD1B9", border: "1px solid #2C3B52" }}
            >
              <Plus size={16} /> Добавить
            </button>
          </div>
          <p className="text-xs mb-3" style={{ color: "#6E8399" }}>
            L — рама · T — импост (делит окно на части) · Z — створка (открывающаяся часть)
          </p>

          <div className="hidden sm:grid grid-cols-[70px_1fr_120px_100px_40px] gap-2 text-xs mb-2" style={{ color: "#6E8399" }}>
            <span>ТИП</span>
            <span>НАЗВАНИЕ</span>
            <span>ДЛИНА, ММ</span>
            <span>КОЛ-ВО</span>
            <span></span>
          </div>

          <div className="flex flex-col gap-2">
            {pieces.map((row) => (
              <div
                key={row.id}
                className="grid grid-cols-2 sm:grid-cols-[70px_1fr_120px_100px_40px] gap-2 items-center rounded p-2"
                style={{ background: "#0F1826" }}
              >
                <select
                  value={row.type || "L"}
                  onChange={(e) => updatePiece(row.id, "type", e.target.value)}
                  className="col-span-2 sm:col-span-1 rounded px-2 py-1.5"
                  style={{
                    background: TYPE_FILLS[row.type || "L"].bg,
                    border: `1px solid ${TYPE_FILLS[row.type || "L"].border}`,
                    color: TYPE_FILLS[row.type || "L"].text,
                    fontWeight: 600,
                  }}
                >
                  <option value="L">L</option>
                  <option value="T">T</option>
                  <option value="Z">Z</option>
                </select>
                <input
                  value={row.label}
                  onChange={(e) => updatePiece(row.id, "label", e.target.value)}
                  placeholder="напр. Рама стойка"
                  className="col-span-2 sm:col-span-1 rounded px-2 py-1.5"
                  style={{ background: "#0B121C", border: "1px solid #2C3B52", color: "#E7EEF4" }}
                />
                <input
                  type="number"
                  value={row.length}
                  onChange={(e) => updatePiece(row.id, "length", e.target.value)}
                  className="mono rounded px-2 py-1.5"
                  style={{ background: "#0B121C", border: "1px solid #2C3B52", color: "#E7EEF4" }}
                />
                <input
                  type="number"
                  value={row.qty}
                  onChange={(e) => updatePiece(row.id, "qty", e.target.value)}
                  className="mono rounded px-2 py-1.5"
                  style={{ background: "#0B121C", border: "1px solid #2C3B52", color: "#E7EEF4" }}
                />
                <button onClick={() => removePiece(row.id)} className="flex justify-center" style={{ color: "#C97064" }}>
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="rounded-lg p-3 mb-5 text-sm" style={{ background: "#3A1E18", border: "1px solid #6B3A2C", color: "#F3B9A8" }}>
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="rounded-lg p-4 sm:p-5" style={{ background: "#16202E", border: "1px solid #223047" }}>
            <h2 className="text-xl font-semibold mb-3" style={{ letterSpacing: "0.02em" }}>
              РЕЗУЛЬТАТ
            </h2>

            <div className="grid grid-cols-3 gap-3 mb-3">
              <Stat label="ХЛЫСТОВ НУЖНО" value={result.totalBars} />
              <Stat label="ДЕТАЛЕЙ ВСЕГО" value={result.totalPieces} />
              <Stat
                label="ОТХОДЫ"
                value={`${result.totalWaste.toLocaleString("ru-RU")} мм · ${result.wastePercent.toFixed(1)}%`}
              />
            </div>

            <div className="grid grid-cols-3 gap-3 mb-6">
              {["L", "T", "Z"].map((t) => (
                <div key={t} className="rounded p-3" style={{ background: "#0F1826", border: `1px solid ${TYPE_FILLS[t].border}` }}>
                  <div className="text-[11px] mb-1" style={{ color: TYPE_FILLS[t].border }}>
                    {t} · {TYPE_LABELS[t]}
                  </div>
                  <div className="mono text-lg font-semibold" style={{ color: "#E7EEF4" }}>
                    {result.typeTotals[t].qty} шт · {result.typeTotals[t].length.toLocaleString("ru-RU")} мм ·{" "}
                    {result.typeTotals[t].bars} хлыст.{result.typeTotals[t].bars === 1 ? "" : "ов"}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-4">
              {result.bars.map((bar, idx) => {
                const used = result.stockLength - Math.max(0, bar.remaining);
                return (
                  <div key={idx}>
                    <div className="flex justify-between text-xs mb-1 mono" style={{ color: "#8FA3B8" }}>
                      <span>
                        ХЛЫСТ {bar.type}-{bar.barIndex} · {TYPE_LABELS[bar.type]}
                      </span>
                      <span>
                        использовано {used.toLocaleString("ru-RU")} / {result.stockLength.toLocaleString("ru-RU")} мм ·
                        остаток {Math.max(0, bar.remaining).toLocaleString("ru-RU")} мм
                      </span>
                    </div>
                    <div
                      className="w-full flex rounded overflow-hidden"
                      style={{ height: 44, background: "#0B121C", border: "1px solid #2C3B52" }}
                    >
                      {bar.cuts.map((cut, cIdx) => {
                        const fill = TYPE_FILLS[cut.type];
                        const widthPct = ((cut.length + result.kerf) / result.stockLength) * 100;
                        return (
                          <div
                            key={cIdx}
                            title={`${cut.label} (${cut.type}): ${cut.length} мм`}
                            style={{
                              width: `${widthPct}%`,
                              background: fill.bg,
                              borderRight: `2px solid ${fill.border}`,
                              color: fill.text,
                            }}
                            className="h-full flex items-center justify-center text-[11px] mono font-medium overflow-hidden px-0.5"
                          >
                            {widthPct > 4 ? cut.length : ""}
                          </div>
                        );
                      })}
                      {bar.remaining > 0 && (
                        <div
                          style={{
                            width: `${(bar.remaining / result.stockLength) * 100}%`,
                            backgroundImage:
                              "repeating-linear-gradient(45deg, rgba(255,138,61,0.18), rgba(255,138,61,0.18) 6px, transparent 6px, transparent 12px)",
                            background: "#1B2430",
                          }}
                          className="h-full flex items-center justify-center text-[10px] mono"
                        >
                          <span style={{ color: "#FF8A3D" }}>
                            {bar.remaining > 260 ? `отход ${Math.round(bar.remaining)}` : ""}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap gap-3 mt-5 text-xs mono">
              {pieces.map((row) => (
                <div key={row.id} className="flex items-center gap-1.5">
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      background: TYPE_FILLS[row.type || "L"].bg,
                      border: `1px solid ${TYPE_FILLS[row.type || "L"].border}`,
                      display: "inline-block",
                      borderRadius: 2,
                    }}
                  />
                  <span style={{ color: "#8FA3B8" }}>
                    [{row.type || "L"}] {row.label || `${row.length} мм`} — {row.length} мм × {row.qty}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {historyLoaded && history.length > 0 && (
          <div className="rounded-lg p-4 sm:p-5 mt-5" style={{ background: "#16202E", border: "1px solid #223047" }}>
            <div className="flex items-center gap-2 mb-3">
              <History size={18} color="#8FA3B8" />
              <h2 className="text-xl font-semibold" style={{ letterSpacing: "0.02em" }}>
                ИСТОРИЯ РАСЧЁТОВ
              </h2>
            </div>
            <div className="flex flex-col gap-2">
              {history.map((entry) => (
                <div
                  key={entry.ts}
                  className="grid grid-cols-[1fr_auto_auto] sm:grid-cols-[160px_1fr_auto_auto] items-center gap-2 sm:gap-3 rounded p-2 text-xs sm:text-sm"
                  style={{ background: "#0F1826" }}
                >
                  <span className="mono" style={{ color: "#8FA3B8" }}>
                    {new Date(entry.ts).toLocaleString("ru-RU")}
                  </span>
                  <span className="hidden sm:inline mono" style={{ color: "#6E8399" }}>
                    хлыст {entry.stockLength} мм · пропил {entry.kerf} мм · {entry.pieces.length}{" "}
                    {entry.pieces.length === 1 ? "позиция" : "позиций"}
                  </span>
                  <span className="mono" style={{ color: "#E7EEF4" }}>
                    {entry.result.totalBars} хлыст.{entry.result.totalBars === 1 ? "" : "ов"} ·{" "}
                    {entry.result.wastePercent.toFixed(1)}% отход
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => restoreHistoryEntry(entry)}
                      title="Открыть этот расчёт"
                      className="p-1.5 rounded"
                      style={{ background: "#1E2C3E", color: "#8FD1B9", border: "1px solid #2C3B52" }}
                    >
                      <RotateCcw size={14} />
                    </button>
                    <button
                      onClick={() => deleteHistoryEntry(entry.ts)}
                      title="Удалить запись"
                      className="p-1.5 rounded"
                      style={{ background: "#1E2C3E", color: "#C97064", border: "1px solid #2C3B52" }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded p-3" style={{ background: "#0F1826", border: "1px solid #223047" }}>
      <div className="text-[11px] mb-1" style={{ color: "#6E8399" }}>
        {label}
      </div>
      <div className="mono text-xl font-semibold" style={{ color: "#E7EEF4" }}>
        {value}
      </div>
    </div>
  );
}
