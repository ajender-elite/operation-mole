/** `git merge-tree --write-tree -z --name-only` output: result tree, conflicted paths, messages. */
export function parseMergeTree(output: string): {
  tree: string;
  conflicted: string[];
  messages: string[];
} {
  const tokens = output.split('\0');
  const tree = tokens[0] ?? '';
  const conflicted: string[] = [];
  let i = 1;
  while (i < tokens.length && tokens[i] !== '') conflicted.push(tokens[i++] ?? '');
  i++; // the empty token ending the conflicted-file list
  const messages: string[] = [];
  while (i < tokens.length) {
    const count = Number(tokens[i]);
    if (!Number.isInteger(count) || tokens[i] === '') break;
    // Every path a CONFLICT message names conflicts, including rename/delete and similar
    // cases where the original path has no conflict stages of its own.
    const type = tokens[i + 1 + count] ?? '';
    if (type.startsWith('CONFLICT')) conflicted.push(...tokens.slice(i + 1, i + 1 + count));
    i += 1 + count + 1; // count, paths, conflict type
    const message = tokens[i++];
    if (message !== undefined) messages.push(message.trimEnd());
  }
  return { tree, conflicted: [...new Set(conflicted)], messages };
}
