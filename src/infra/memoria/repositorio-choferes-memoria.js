// Adaptador en memoria de RepositorioChoferes (solo lo que necesita ubicaciones:
// leer un chofer y cambiar su disponibilidad). El adaptador real vive junto al
// modulo de choferes; aca se da la version falsa para tests y arranque sin DB.

export function crearRepositorioChoferesMemoria({ choferes = [] } = {}) {
  // id -> {id, habilitado, disponible}
  const tabla = new Map();

  function cargar(chofer) {
    if (!chofer || typeof chofer.id !== 'string' || chofer.id.length === 0) {
      throw new Error('Cada chofer sembrado debe tener un id no vacio.');
    }
    tabla.set(chofer.id, {
      id: chofer.id,
      habilitado: chofer.habilitado ?? true,
      disponible: chofer.disponible ?? false,
    });
  }

  for (const chofer of choferes) cargar(chofer);

  return {
    async buscarPorId(choferId) {
      const fila = tabla.get(choferId);
      return fila ? { ...fila } : null;
    },

    async cambiarDisponibilidad(choferId, disponible) {
      const fila = tabla.get(choferId);
      if (!fila) return null;
      fila.disponible = Boolean(disponible);
      return { ...fila };
    },

    // Auxiliar de test: alta rapida de choferes.
    _sembrar(chofer) {
      cargar(chofer);
    },
  };
}
