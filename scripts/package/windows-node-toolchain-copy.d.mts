/** Fixed Windows Electron copy filter; development bytes are never a release asset source. */
export function prepareWindowsNodeElectronCopyFilter(source: string): (selected: string) => boolean;
