// Adaptador en memoria del RegistroMetricas: guarda latencias y calcula p50,
// p95 y p99. La ruta GET /metricas lo expone (solo administrador/interno).
//
// Decisiones:
// 1) Percentiles por "nearest-rank": con la muestra ordenada de menor a mayor,
//    el percentil p es el valor en el indice ceil(p/100 * n) - 1. Es simple,
//    determinista y no interpola; para latencias alcanza y es facil de defender.
// 2) Capacidad acotada: se descartan las muestras mas viejas para no crecer sin
//    limite. Es una muestra de ventana movil, no el total historico.
// 3) Se guarda una COPIA ordenada al consultar; no se ordena in-place para no
//    alterar el orden de llegada (por si se quiere inspeccionar despues).

export function crearRegistroMetricasMemoria({ capacidad = 100000 } = {}) {
  if (!Number.isInteger(capacidad) || capacidad <= 0) {
    throw new Error('capacidad debe ser un entero positivo.');
  }
  let muestras = [];

  function percentil(ordenadas, p) {
    if (ordenadas.length === 0) return 0;
    const indice = Math.ceil((p / 100) * ordenadas.length) - 1;
    return ordenadas[Math.max(0, Math.min(indice, ordenadas.length - 1))];
  }

  return {
    observar(duracionMs) {
      if (typeof duracionMs !== 'number' || !Number.isFinite(duracionMs) || duracionMs < 0) {
        return; // una medicion invalida no debe romper el request
      }
      muestras.push(duracionMs);
      if (muestras.length > capacidad) {
        muestras.splice(0, muestras.length - capacidad);
      }
    },

    percentiles() {
      const ordenadas = [...muestras].sort((a, b) => a - b);
      const n = ordenadas.length;
      return {
        p50: percentil(ordenadas, 50),
        p95: percentil(ordenadas, 95),
        p99: percentil(ordenadas, 99),
        max: n === 0 ? 0 : ordenadas[n - 1],
        total: n,
      };
    },
  };
}
