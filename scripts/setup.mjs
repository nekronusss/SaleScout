import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const path = new URL('../.env', import.meta.url);
const password = randomBytes(24).toString('hex');
const template = (await readFile(new URL('../.env.example', import.meta.url), 'utf8'))
  .replaceAll('CHANGE_ME', password).replace('GENERATE_WITH_NPM_RUN_SETUP', randomBytes(48).toString('hex'));
try {
  await writeFile(path, template, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with unique database and session secrets. Do not commit this file.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env already exists; kept unchanged.');
  else throw error;
}
