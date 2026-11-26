import { useState } from 'react';

import { pedir } from './api.js';
import Pasajero from './Pasajero.jsx';
import Chofer from './Chofer.jsx';

// La sesion vive en sessionStorage: cada pestana es una sesion distinta, asi
// se puede probar pasajero y chofer a la vez en el mismo navegador.
function leerSesion() {
  try {
    return JSON.parse(sessionStorage.getItem('sesion') ?? 'null');
  } catch {
    return null;
  }
}

function Login({ alEntrar }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [enviando, setEnviando] = useState(false);

  async function entrar(evento) {
    evento.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      const { token, usuario } = await pedir('/auth/login', { metodo: 'POST', cuerpo: { email, password } });
      alEntrar({ token, usuario });
    } catch (err) {
      setError(err.status === 429 ? 'Demasiados intentos, esperá un minuto.' : 'Email o contraseña incorrectos.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className="tarjeta login" onSubmit={entrar}>
      <h1>Movilidad urbana</h1>
      <label>
        Email
        <input data-testid="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>
        Contraseña
        <input data-testid="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <button data-testid="login-entrar" type="submit" disabled={enviando}>{enviando ? 'Entrando…' : 'Entrar'}</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

export default function App() {
  const [sesion, setSesion] = useState(leerSesion);

  function entrar(nueva) {
    sessionStorage.setItem('sesion', JSON.stringify(nueva));
    setSesion(nueva);
  }

  function salir() {
    sessionStorage.removeItem('sesion');
    setSesion(null);
  }

  if (!sesion) return <main><Login alEntrar={entrar} /></main>;

  const { usuario, token } = sesion;
  return (
    <main>
      <header className="barra">
        <span>
          {usuario.nombre} · <strong data-testid="rol">{usuario.rol}</strong>
        </span>
        <button className="secundario" onClick={salir}>Salir</button>
      </header>
      {usuario.rol === 'pasajero' && <Pasajero token={token} />}
      {usuario.rol === 'chofer' && <Chofer token={token} usuario={usuario} />}
      {usuario.rol !== 'pasajero' && usuario.rol !== 'chofer' && (
        <p className="tarjeta">Esta interfaz es para pasajeros y choferes. El panel del operador se usa por la API (<code>GET /operador/viajes</code>).</p>
      )}
    </main>
  );
}
