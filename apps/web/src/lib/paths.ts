/** Whether `path` is `folder` itself or inside it (the root, `''`, holds everything). */
export function isWithin(folder: string, path: string): boolean {
  return folder === '' || path === folder || path.startsWith(`${folder}/`);
}
