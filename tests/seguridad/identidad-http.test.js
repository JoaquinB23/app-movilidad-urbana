// Tests de seguridad del módulo de identidad/administración/reasignación
// (Persona C): autorización por recurso (acceder a un viaje ajeno por id),
// escalada de rol, prototype pollution (__proto__ y constructor.prototype),
// inyección SQL en un campo de búsqueda y rate limit del login (429).
// Corren con Express real en puerto efímero, argon2 y JWT REALES (costo bajo
// por env) y repositorios en memoria (sin base de datos).

process.env.ARGON2_MEMORIA_KIB = '8192';
process.env.ARGON2_ITERACIONES = '2';
process.env.ARGON2_PARALELISMO = '1';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';

import { crearServiciosIdentidad } from '../../src/dominio/identidad/servicios.js';
import { crearHasherArgon2 } from '../../src/infra/seguridad/hasher-argon2.js';
import { crearTokensJwt } from '../../src/infra/seguridad/tokens-jwt.js';
import { crearAutenticar } from '../../src/infra/http/autenticacion.js';
import { crearRutasAuth, MAPEO_HTTP_IDENTIDAD } from '../../src/infra/http/rutas/auth.js';
import { crearRutasAdmin } from '../../src/infra/http/rutas/admin.js';
import { crearRutasReasignacion, MAPEO_HTTP_REASIGNACION } from '../../src/infra/http/rutas/reasignacion.js';
import { crearRepositorioUsuariosMemoria } from '../../src/infra/memoria/repositorio-usuarios-memoria.js';
import { crearRepositorioAdministracionMemoria } from '../../src/infra/memoria/repositorio-administracion-memoria.js';

const SECRETO = 'secreto-de-prueba-con-mas-de-32-caracteres!!';
const MAPEO = { ...MAPEO_HTTP_IDENTIDAD, ...MAPEO_HTTP_REASIGNACION };

const VIAJE_ID = randomUUID();
const OTRO_VIAJE_ID = randomUUID();

let contexto;

async function montarApp({ limiteLogin = 100 } = {}) {
  const hasher = await crearHasherArgon2();
  const tokens = crearTokensJwt({ JWT_SECRETO: SECRETO });
  const repositorioUsuarios = crearRepositorioUsuariosMemoria();
  const repositorioAdministracion = crearRepositorioAdministracionMemoria();
  const serviciosIdentidad = crearServiciosIdentidad({
    repositorioUsuarios,
    hasher,
    tokens,
    reloj: { ahora: () => new Date() },
  });
  const autenticar = crearAutenticar({ tokens });

  // No hay endpoint de alta de administradores: el token de admin se emite
  // directamente (equivale a un admin sembrado por seed).
  const tokenAdmin = tokens.firmar({ sub: randomUUID(), rol: 'administrador' });

  const rateLimitLogin = rateLimit({
    windowMs: 60000,
    max: limiteLogin,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({ error: { codigo: 'DEMASIADAS_PETICIONES', mensaje: 'Limite de tasa superado.', idCorrelacion: 'test' } }),
  });

  // Viajes/asignaciones de prueba para la autorización por recurso.
  const pasajeroDuenoId = randomUUID();
  const choferAsignadoId = randomUUID();
  const viajes = new Map([
    [VIAJE_ID, { id: VIAJE_ID, pasajeroId: pasajeroDuenoId, estado: 'asignado' }],
    [OTRO_VIAJE_ID, { id: OTRO_VIAJE_ID, pasajeroId: randomUUID(), estado: 'asignado' }],
  ]);
  const asignaciones = [
    { id: randomUUID(), viajeId: VIAJE_ID, choferId: choferAsignadoId, desde: new Date(), hasta: null, motivoFin: null },
  ];
  const repositorioViajes = { buscarPorId: async (id) => viajes.get(id) ?? null };
  const repositorioAsignaciones = {
    buscarAbiertaPorViaje: async (viajeId) =>
      asignaciones.find((a) => a.viajeId === viajeId && a.hasta === null) ?? null,
    listarPorViaje: async (viajeId) => asignaciones.filter((a) => a.viajeId === viajeId),
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use(crearRutasAuth({ serviciosIdentidad, autenticar, rateLimitLogin }));
  app.use(crearRutasAdmin({ serviciosIdentidad, repositorioAdministracion, autenticar }));
  app.use(
    crearRutasReasignacion({
      autenticar,
      reasignarViaje: async () => {
        throw Object.assign(new Error('Sin candidatos.'), { codigo: 'SIN_CANDIDATOS' });
      },
      repositorioViajes,
      repositorioAsignaciones,
    })
  );
  app.use((err, req, res, next) => {
    void next;
    const status = MAPEO[err.codigo] ?? 500;
    res.status(status).json({
      error: {
        codigo: err.codigo ?? 'ERROR_INTERNO',
        mensaje: status === 500 ? 'Error interno del servidor.' : err.message,
        idCorrelacion: 'test',
      },
    });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    tokens,
    tokenAdmin,
    pasajeroDuenoId,
    choferAsignadoId,
    repositorioUsuarios,
    cerrar: () => new Promise((resolve) => server.close(resolve)),
  };
}

function json(metodo, token, body) {
  return {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

before(async () => {
  contexto = await montarApp();
});
after(async () => contexto.cerrar());

// --- registro y login -------------------------------------------------

test('registro de pasajero + login + GET /me', async () => {
  const { baseUrl } = contexto;
  const registro = await fetch(`${baseUrl}/auth/registro/pasajero`, json('POST', null, {
    email: 'Ana@Test.Invalid',
    password: 'clave-segura-1',
    nombre: 'Ana',
  }));
  assert.equal(registro.status, 201);
  const perfil = await registro.json();
  assert.equal(perfil.email, 'ana@test.invalid'); // normalizado a minúsculas
  assert.equal(perfil.rol, 'pasajero');
  assert.equal(perfil.passwordHash, undefined); // el hash JAMÁS sale por la API

  const login = await fetch(`${baseUrl}/auth/login`, json('POST', null, {
    email: 'ana@test.invalid',
    password: 'clave-segura-1',
  }));
  assert.equal(login.status, 200);
  const sesion = await login.json();
  assert.ok(sesion.token);

  const me = await fetch(`${baseUrl}/me`, json('GET', sesion.token));
  assert.equal(me.status, 200);
  assert.equal((await me.json()).email, 'ana@test.invalid');
});

test('login con credenciales malas responde 401 sin distinguir si el email existe', async () => {
  const { baseUrl } = contexto;
  const inexistente = await fetch(`${baseUrl}/auth/login`, json('POST', null, {
    email: 'nadie@test.invalid', password: 'clave-cualquiera',
  }));
  const malaClave = await fetch(`${baseUrl}/auth/login`, json('POST', null, {
    email: 'ana@test.invalid', password: 'clave-equivocada',
  }));
  assert.equal(inexistente.status, 401);
  assert.equal(malaClave.status, 401);
  const a = await inexistente.json();
  const b = await malaClave.json();
  assert.equal(a.error.codigo, b.error.codigo); // mismo código: no filtra existencia
});

test('registro de chofer: nace NO habilitado y el admin lo habilita', async () => {
  const { baseUrl, tokenAdmin } = contexto;
  const registro = await fetch(`${baseUrl}/auth/registro/chofer`, json('POST', null, {
    email: 'chofer1@test.invalid',
    password: 'clave-segura-1',
    nombre: 'Carlos',
    vehiculo: { patente: 'ab123cd', marca: 'Toyota', modelo: 'Corolla', color: 'Gris' },
  }));
  assert.equal(registro.status, 201);
  const perfil = await registro.json();
  assert.equal(perfil.chofer.habilitado, false);
  assert.equal(perfil.chofer.patente, 'AB123CD');

  const patch = await fetch(`${baseUrl}/admin/choferes/${perfil.id}/habilitacion`,
    json('PATCH', tokenAdmin, { habilitado: true }));
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).habilitado, true);

  const lista = await fetch(`${baseUrl}/admin/choferes?habilitado=true`, json('GET', tokenAdmin));
  assert.equal(lista.status, 200);
  const { choferes } = await lista.json();
  assert.ok(choferes.some((c) => c.id === perfil.id));
});

// --- escalada de rol --------------------------------------------------

test('escalada de rol: un pasajero no accede a /admin/* (403)', async () => {
  const { baseUrl, tokens } = contexto;
  const tokenPasajero = tokens.firmar({ sub: randomUUID(), rol: 'pasajero' });
  for (const [metodo, ruta, body] of [
    ['GET', '/admin/choferes'],
    ['PATCH', `/admin/choferes/${randomUUID()}/habilitacion`, { habilitado: true }],
    ['PUT', '/admin/tarifas', { bajadaBanderaCentavos: 1, precioKmCentavos: 1, precioMinutoCentavos: 1 }],
    ['GET', '/admin/parametros'],
    ['PUT', '/admin/parametros', { umbral_reasignacion_s: 10 }],
  ]) {
    const res = await fetch(`${baseUrl}${ruta}`, json(metodo, tokenPasajero, body));
    assert.equal(res.status, 403, `${metodo} ${ruta} debe responder 403`);
    assert.equal((await res.json()).error.codigo, 'ROL_NO_AUTORIZADO');
  }
});

test('escalada de rol: un token re-firmado con otro secreto es 401', async () => {
  const { baseUrl } = contexto;
  // Atacante que decodifica su JWT, se pone rol administrador y lo firma con
  // un secreto propio: la verificación de firma lo rechaza.
  const falsificado = jwt.sign(
    { sub: randomUUID(), rol: 'administrador' },
    'otro-secreto-que-no-es-el-del-servidor!!!!!',
    { algorithm: 'HS256', issuer: 'app-movilidad-urbana', audience: 'app-movilidad-urbana' }
  );
  const res = await fetch(`${baseUrl}/admin/choferes`, json('GET', falsificado));
  assert.equal(res.status, 401);
});

test('sin token o token corrupto: 401 en rutas autenticadas', async () => {
  const { baseUrl } = contexto;
  assert.equal((await fetch(`${baseUrl}/me`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/me`, json('GET', 'no.es.unjwt'))).status, 401);
});

// --- prototype pollution ----------------------------------------------

test('prototype pollution: __proto__ y constructor.prototype se rechazan con 400', async () => {
  const { baseUrl } = contexto;
  const conProto = await fetch(`${baseUrl}/auth/registro/pasajero`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"email":"p@test.invalid","password":"clave-segura-1","nombre":"P","__proto__":{"admin":true}}',
  });
  assert.equal(conProto.status, 400);

  const conConstructor = await fetch(`${baseUrl}/auth/registro/pasajero`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"email":"p2@test.invalid","password":"clave-segura-1","nombre":"P","constructor":{"prototype":{"admin":true}}}',
  });
  assert.equal(conConstructor.status, 400);

  // El prototipo global quedó intacto.
  assert.equal({}.admin, undefined);
  assert.equal(Object.prototype.admin, undefined);
});

// --- inyección SQL ----------------------------------------------------

test('inyección SQL en un campo de búsqueda se rechaza con 400', async () => {
  const { baseUrl, tokenAdmin } = contexto;
  const inyeccion = encodeURIComponent("' OR 1=1 --");
  const res = await fetch(`${baseUrl}/admin/choferes?habilitado=${inyeccion}`, json('GET', tokenAdmin));
  assert.equal(res.status, 400); // el enum estricto de zod la rechaza antes de tocar el repo
});

test('inyección SQL en email de login no rompe el servidor (401, nunca 500)', async () => {
  const { baseUrl } = contexto;
  const res = await fetch(`${baseUrl}/auth/login`, json('POST', null, {
    email: "admin'--@test.invalid",
    password: "x' OR '1'='1",
  }));
  assert.equal(res.status, 401);
});

// --- rate limit -------------------------------------------------------

test('rate limit del login: la petición que excede el límite recibe 429', async () => {
  const app = await montarApp({ limiteLogin: 3 });
  try {
    let ultima;
    for (let i = 0; i < 4; i += 1) {
      ultima = await fetch(`${app.baseUrl}/auth/login`, json('POST', null, {
        email: 'nadie@test.invalid', password: 'clave-cualquiera',
      }));
    }
    assert.equal(ultima.status, 429);
    assert.equal((await ultima.json()).error.codigo, 'DEMASIADAS_PETICIONES');
  } finally {
    await app.cerrar();
  }
});

// --- autorización por recurso -----------------------------------------

test('GET /viajes/:id/asignaciones: el pasajero dueño ve el historial; un ajeno recibe 404', async () => {
  const { baseUrl, tokens, pasajeroDuenoId } = contexto;
  const tokenDueno = tokens.firmar({ sub: pasajeroDuenoId, rol: 'pasajero' });
  const tokenAjeno = tokens.firmar({ sub: randomUUID(), rol: 'pasajero' });

  const ok = await fetch(`${baseUrl}/viajes/${VIAJE_ID}/asignaciones`, json('GET', tokenDueno));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).asignaciones.length, 1);

  // Mismo id, otro pasajero: 404 (no 403) para no confirmar que el id existe.
  const ajeno = await fetch(`${baseUrl}/viajes/${VIAJE_ID}/asignaciones`, json('GET', tokenAjeno));
  assert.equal(ajeno.status, 404);

  // Operador y admin sí acceden.
  const tokenOperador = tokens.firmar({ sub: randomUUID(), rol: 'operador' });
  assert.equal((await fetch(`${baseUrl}/viajes/${VIAJE_ID}/asignaciones`, json('GET', tokenOperador))).status, 200);
});

test('POST /viajes/:id/rechazar-continuar: solo el chofer asignado; otros reciben 404', async () => {
  const { baseUrl, tokens, choferAsignadoId } = contexto;
  const tokenOtroChofer = tokens.firmar({ sub: randomUUID(), rol: 'chofer' });
  const ajeno = await fetch(`${baseUrl}/viajes/${VIAJE_ID}/rechazar-continuar`,
    json('POST', tokenOtroChofer, { motivo: 'no puedo seguir' }));
  assert.equal(ajeno.status, 404);

  // El chofer asignado sí pasa la autorización (acá el caso de uso stub
  // responde SIN_CANDIDATOS => 409, lo que prueba que llegó al dominio).
  const tokenAsignado = tokens.firmar({ sub: choferAsignadoId, rol: 'chofer' });
  const propio = await fetch(`${baseUrl}/viajes/${VIAJE_ID}/rechazar-continuar`,
    json('POST', tokenAsignado, { motivo: 'no puedo seguir' }));
  assert.equal(propio.status, 409);
  assert.equal((await propio.json()).error.codigo, 'SIN_CANDIDATOS');
});
