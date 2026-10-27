// Small privileged helper. No shell, network, external modules, arbitrary paths
// or caller-provided file content. Only this exact recovery hostname is changed.
import { readFileSync, lstatSync, openSync, writeSync, fsyncSync, closeSync, fchownSync, fchmodSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST } from './profile.mjs';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function hostsLine(id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Identificador da instalação inválido.');
  return `127.0.0.1 ${HOST} # picnic-recovery-setup-${id}`;
}
export function inspectHosts(bytes) {
  const matches = bytes.toString('utf8').split(/\r?\n/).map(line => line.split('#')[0].trim().split(/\s+/)).filter(parts => parts.slice(1).some(name => name.toLowerCase().replace(/\.$/, '') === HOST));
  if (matches.some(parts => parts[0] !== '127.0.0.1')) throw new Error('Já existe uma resolução diferente para o domínio. Não será sobrescrita.');
  return matches.length > 0;
}
export function changeHosts(bytes, operation, id, expectedDigest) {
  const line = hostsLine(id);
  const addition = Buffer.from(`\n${line}\n`);
  if (operation === 'add') {
    if (digest(bytes) !== expectedDigest) throw new Error('/etc/hosts mudou desde a revisão. Prepare uma nova revisão antes de alterar.');
    if (inspectHosts(bytes)) return bytes; // Existing mapping belongs to someone else.
    return Buffer.concat([bytes, addition]);
  }
  if (operation !== 'remove') throw new Error('Operação inválida.');
  const offset = bytes.indexOf(addition);
  if (offset === -1) {
    if (bytes.includes(Buffer.from(`picnic-recovery-setup-${id}`))) throw new Error('A linha desta instalação foi editada. Revise antes de remover.');
    return bytes;
  }
  if (bytes.indexOf(addition, offset + addition.length) !== -1) throw new Error('Marcador duplicado. Revise /etc/hosts.');
  return Buffer.concat([bytes.subarray(0, offset), bytes.subarray(offset + addition.length)]);
}
export function updateHostsFile(path, operation, id, expectedDigest) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('/etc/hosts não é um arquivo regular.');
  const before = readFileSync(path);
  const after = changeHosts(before, operation, id, expectedDigest);
  // Atomic replacement avoids leaving a truncated hosts file if interrupted.
  // Recheck just before rename and preserve ownership/mode and unrelated bytes.
  if (!after.equals(before)) {
    const temporary = join(dirname(path), `.picnic-hosts-${randomBytes(16).toString('hex')}`);
    const fd = openSync(temporary, 'wx', stat.mode & 0o777);
    try {
      let offset = 0;
      while (offset < after.length) offset += writeSync(fd, after, offset);
      fchownSync(fd, stat.uid, stat.gid); fchmodSync(fd, stat.mode & 0o777); fsyncSync(fd);
      if (!readFileSync(path).equals(before)) throw new Error('/etc/hosts mudou durante a operação.');
      renameSync(temporary, path);
    } finally {
      closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (!readFileSync(path).equals(after)) throw new Error('Não foi possível verificar /etc/hosts.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.getuid() !== 0) throw new Error('Esta operação usa a autorização administrativa do sistema.');
  updateHostsFile('/etc/hosts', ...process.argv.slice(2));
}
