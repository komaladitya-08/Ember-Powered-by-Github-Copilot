/** Names people know apps by, for questions, grants and settings (apps report a program or desktop id). */

/** Familiar names for apps that report a program or desktop id instead. */
const APP_NAMES: Record<string, string> = {
  "gnome-control-center": "Settings",
  "org.gnome.settings": "Settings",
  "org.gnome.controlcenter": "Settings",
  nautilus: "Files",
  "org.gnome.nautilus": "Files",
  "gnome-terminal-server": "Terminal",
  "gnome-terminal": "Terminal",
  "org.gnome.terminal": "Terminal",
  gedit: "gedit",
  "org.gnome.gedit": "gedit",
  "gnome-text-editor": "Text Editor",
  "org.gnome.texteditor": "Text Editor",
  "gnome-calculator": "Calculator",
  "org.gnome.calculator": "Calculator",
  evince: "Document Viewer",
  eog: "Image Viewer",
  "gnome-system-monitor": "System Monitor",
  "soffice.bin": "LibreOffice",
  soffice: "LibreOffice",
  firefox: "Firefox",
  thunderbird: "Thunderbird",
  mousepad: "Mousepad",
};

export function friendlyApp(name: string): string {
  const n = name.trim();
  const known = APP_NAMES[n.toLowerCase()];
  if (known) return known;
  if (/^libreoffice/i.test(n)) return "LibreOffice";
  // A desktop id (org.example.App): its last part.
  const dotted = /^[a-z]{2,}\.[\w-]+\.([\w-]+)$/i.exec(n);
  if (dotted) return dotted[1];
  // A program name (all lower case, no spaces): capitalised.
  if (/^[a-z][a-z0-9-]*$/.test(n)) return n[0].toUpperCase() + n.slice(1);
  return n;
}

