export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    const key = token.replace(/^--?/, "");
    const next = argv[index + 1];
    const value = next && !next.startsWith("-") ? next : true;
    if (value !== true) {
      index += 1;
    }
    assignFlag(flags, key, value);
  }

  return { positionals, flags };
}

function assignFlag(
  flags: Record<string, string | boolean | string[]>,
  key: string,
  value: string | boolean,
): void {
  const current = flags[key];
  if (current == null) {
    flags[key] = value;
    return;
  }
  if (Array.isArray(current)) {
    current.push(String(value));
    return;
  }
  flags[key] = [String(current), String(value)];
}

export function getStringFlag(flags: ParsedArgs["flags"], key: string): string | undefined {
  const value = flags[key];
  return Array.isArray(value) ? value.at(-1) : typeof value === "string" ? value : undefined;
}

export function getBooleanFlag(flags: ParsedArgs["flags"], key: string): boolean {
  return Boolean(flags[key]);
}

export function getMultiFlag(flags: ParsedArgs["flags"], key: string): string[] {
  const value = flags[key];
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [String(value)];
}

