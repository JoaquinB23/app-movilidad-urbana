import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testPath = fileURLToPath(new URL('./aceptacion-simultanea.test.js', import.meta.url));

for (let corrida = 1; corrida <= 10; corrida += 1) {
  console.log(`\nCorrida ${corrida}/10`);
  const resultado = spawnSync(
    process.execPath,
    ['--env-file=.env', '--test', testPath],
    { stdio: 'inherit' }
  );
  if (resultado.error) {
    console.error(`No se pudo iniciar la corrida ${corrida}: ${resultado.error.message}`);
    process.exit(1);
  }
  if (resultado.status !== 0) {
    process.exit(resultado.status ?? 1);
  }
}

console.log('\nLas 10 corridas finalizaron correctamente.');
