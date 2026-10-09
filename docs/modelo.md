# Modelo de dominio

Estados del viaje: solicitado, asignado, chofer_en_camino, en_curso, finalizado, cancelado_pasajero, cancelado_chofer, sin_choferes.
Tablas compartidas: usuarios, choferes (estado, disponible, habilitado, flota), viajes, ofertas_viaje, asignaciones_viaje (historial), ubicaciones_actuales, ubicaciones_historial.
Rangos de migraciones para no pisarse: A usa 1xx_, B 2xx_, C 3xx_. Alguien crea 001_base.sql primero.
Orden de bloqueos: siempre primero el viaje y después el chofer (fijarlo evita interbloqueos).
Carpetas por dueño: src/dominio/<modulo>/, src/infra/http/rutas/<modulo>.js, tests/*/<modulo>*. Solo se toca composicion.js con cambios mínimos y por PR.