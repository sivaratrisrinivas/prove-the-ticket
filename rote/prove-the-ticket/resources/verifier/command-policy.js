import path from 'node:path';

const ABSOLUTE_EXECUTABLE_ROOTS = ['/bin', '/lib', '/lib64', '/sbin', '/usr'];
const INSTALL_COMMANDS = new Map([
  ['npm', new Set(['install', 'i', 'ci', 'update', 'uninstall'])],
  ['pnpm', new Set(['add', 'install', 'update', 'remove', 'import'])],
  ['yarn', new Set(['add', 'install', 'remove', 'up'])],
  ['bun', new Set(['add', 'install', 'remove', 'update'])],
]);

export function isInstallCommand(command) {
  const executable = path.basename(command.executable).toLowerCase();
  const args = command.args || [];
  if (['npx', 'pnpx', 'bunx'].includes(executable)) return true;
  if (executable === 'yarn' && args.some((arg) => arg.toLowerCase() === 'dlx')) return true;
  if (executable === 'pnpm' && args.some((arg) => arg.toLowerCase() === 'dlx')) return true;
  if (executable === 'corepack') {
    const packageManagerIndex = args.findIndex((arg) => ['npm', 'pnpm', 'yarn', 'bun'].includes(arg.toLowerCase()));
    if (packageManagerIndex >= 0) {
      return isInstallCommand({
        executable: args[packageManagerIndex],
        args: args.slice(packageManagerIndex + 1),
      });
    }
  }
  if (executable === 'npm' && args.some((arg) => ['exec', 'x'].includes(arg.toLowerCase()))) return true;
  const actions = INSTALL_COMMANDS.get(executable);
  return Boolean(actions && args.some((arg) => actions.has(arg.toLowerCase())));
}

export function isAbsoluteCommandPath(value) {
  return path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

export function isAllowedAbsoluteExecutable(value) {
  if (!isAbsoluteCommandPath(value)) return true;
  if (!path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === process.execPath
    || ABSOLUTE_EXECUTABLE_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function isSafeCommandExecutable(value) {
  if (isAbsoluteCommandPath(value)) return isAllowedAbsoluteExecutable(value);
  if (value.includes('\\')) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && part !== '\\');
}
